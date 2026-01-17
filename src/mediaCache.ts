type MediaKind = 'video' | 'audio' | 'other';

const guessKind = (src: string): MediaKind => {
  const lower = src.toLowerCase();
  if (lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.mov') || lower.endsWith('.m4v')) return 'video';
  if (lower.endsWith('.mp3') || lower.endsWith('.wav') || lower.endsWith('.ogg') || lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio';
  return 'other';
};

class MediaCache {
  private blobUrlBySrc = new Map<string, string>();
  private pendingBySrc = new Map<string, Promise<string>>();
  private metaBySrc = new Map<string, { name?: string; mimeType?: string }>();
  private durationSecBySrc = new Map<string, number>();
  private pendingDurationBySrc = new Map<string, Promise<number | null>>();

  registerSrcMeta(src: string, meta: { name?: string; mimeType?: string }): void {
    const key = String(src ?? '');
    if (!key) return;
    const next = {
      name: meta?.name ? String(meta.name) : undefined,
      mimeType: meta?.mimeType ? String(meta.mimeType) : undefined,
    };
    // Keep the most informative values we have.
    const existing = this.metaBySrc.get(key);
    this.metaBySrc.set(key, {
      name: existing?.name ?? next.name,
      mimeType: existing?.mimeType ?? next.mimeType,
    });
  }

  getSrcMeta(src: string): { name?: string; mimeType?: string } | undefined {
    const key = String(src ?? '');
    if (!key) return undefined;
    return this.metaBySrc.get(key);
  }

  /** Returns the cached duration (seconds) if known. */
  getCachedDurationSec(src: string): number | undefined {
    const key = String(src ?? '');
    if (!key) return undefined;
    const value = this.durationSecBySrc.get(key);
    if (value == null) return undefined;
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value;
  }

  /**
   * Attempts to read media duration from browser metadata (seconds).
   * Returns null when duration cannot be determined (e.g. unsupported/CORS/streaming).
   */
  async getDurationSec(src: string, kindHint?: MediaKind): Promise<number | null> {
    const key = String(src ?? '');
    if (!key) return null;

    const cached = this.getCachedDurationSec(key);
    if (cached != null) return cached;

    const pending = this.pendingDurationBySrc.get(key);
    if (pending) return pending;

    const task = (async () => {
      const kind = kindHint ?? guessKind(key);
      if (kind !== 'video' && kind !== 'audio') return null;

      const el: HTMLMediaElement = kind === 'video' ? document.createElement('video') : document.createElement('audio');
      el.preload = 'metadata';
      // This can help some browsers fetch metadata without credentials.
      try {
        (el as any).crossOrigin = 'anonymous';
      } catch {
        // ignore
      }

      const duration = await new Promise<number | null>((resolve) => {
        let done = false;
        let timeoutId: number | null = null;

        const finish = (value: number | null) => {
          if (done) return;
          done = true;
          cleanup();
          resolve(value);
        };

        const onLoadedMetadata = () => {
          const d = Number(el.duration);
          if (Number.isFinite(d) && d > 0) {
            finish(d);
            return;
          }
          // Some formats report duration later.
          queueMicrotask(() => {
            const d2 = Number(el.duration);
            finish(Number.isFinite(d2) && d2 > 0 ? d2 : null);
          });
        };

        const onDurationChange = () => {
          const d = Number(el.duration);
          if (Number.isFinite(d) && d > 0) finish(d);
        };

        const onError = () => finish(null);

        const cleanup = () => {
          if (timeoutId != null) {
            try {
              window.clearTimeout(timeoutId);
            } catch {
              // ignore
            }
            timeoutId = null;
          }
          el.removeEventListener('loadedmetadata', onLoadedMetadata);
          el.removeEventListener('durationchange', onDurationChange);
          el.removeEventListener('error', onError);
          try {
            el.src = '';
            el.load();
          } catch {
            // ignore
          }
        };

        el.addEventListener('loadedmetadata', onLoadedMetadata);
        el.addEventListener('durationchange', onDurationChange);
        el.addEventListener('error', onError);

        // Timeout: metadata should be quick; fall back if it isn't.
        const timeoutMs = 4000;
        timeoutId = window.setTimeout(() => finish(null), timeoutMs);

        el.src = key;
      });

      if (duration != null && Number.isFinite(duration) && duration > 0) {
        this.durationSecBySrc.set(key, duration);
        return duration;
      }

      return null;
    })()
      .catch((err) => {
        console.warn('[mediaCache] duration probe failed:', key, err);
        return null;
      })
      .finally(() => {
        this.pendingDurationBySrc.delete(key);
      });

    this.pendingDurationBySrc.set(key, task);
    return task;
  }

  /**
   * Preloads a URL into memory and returns a blob: URL.
   * Useful to avoid runtime buffering/stalls when seeking frequently.
   */
  async preloadToBlobUrl(src: string): Promise<string> {
    if (!src) return src;

    // Already-local sources: no need (and often impossible) to "fetch" them.
    if (src.startsWith('blob:') || src.startsWith('data:')) return src;

    const existing = this.blobUrlBySrc.get(src);
    if (existing) return existing;

    const pending = this.pendingBySrc.get(src);
    if (pending) return pending;

    const task = (async () => {
      const response = await fetch(src, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Failed to fetch ${src}: ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      this.blobUrlBySrc.set(src, url);
      return url;
    })()
      .catch((err) => {
        // If preload fails, fall back to the original src.
        console.warn('[mediaCache] preload failed:', src, err);
        return src;
      })
      .finally(() => {
        this.pendingBySrc.delete(src);
      });

    this.pendingBySrc.set(src, task);
    return task;
  }

  /** Returns a blob URL if available, otherwise the original `src`. */
  resolve(src: string): string {
    return this.blobUrlBySrc.get(src) ?? src;
  }

  /** Starts preload in background (non-blocking). */
  warm(src: string): void {
    if (!src) return;
    if (src.startsWith('blob:') || src.startsWith('data:')) return;
    void this.preloadToBlobUrl(src);
  }

  /**
   * Preload a list of srcs with bounded concurrency.
   *
   * This is useful when you know ahead of time which assets will be scrubbed/seeked,
   * so we can eliminate network stalls during interaction.
   */
  async warmAll(
    srcs: Iterable<string>,
    opts?: {
      /** Maximum number of concurrent fetches. Defaults to 3. */
      concurrency?: number;
      /** Yield back to the event loop between items. Defaults to true. */
      yieldBetween?: boolean;
    }
  ): Promise<void> {
    const unique: string[] = [];
    const seen = new Set<string>();

    for (const raw of srcs) {
      const src = String(raw ?? '');
      if (!src) continue;
      if (seen.has(src)) continue;
      seen.add(src);

      const kind = guessKind(src);
      if (kind !== 'video' && kind !== 'audio') continue;
      unique.push(src);
    }

    if (unique.length === 0) return;

    const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? 3));
    const yieldBetween = opts?.yieldBetween !== false;

    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
      while (idx < unique.length) {
        const src = unique[idx++];
        await this.preloadToBlobUrl(src);
        if (yieldBetween) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    });

    await Promise.all(workers);
  }

  /** Convenience: preload all unique action.data.src from editor data. */
  warmFromEditorData(editorData: unknown): void {
    const srcs = new Set<string>();
    const rows = Array.isArray(editorData) ? editorData : [];

    for (const row of rows) {
      const actions = (row as any)?.actions;
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        const src = (action as any)?.data?.src;
        const previewSrc = (action as any)?.data?.previewSrc;
        if (typeof src === 'string' && src) srcs.add(src);
        if (typeof previewSrc === 'string' && previewSrc) srcs.add(previewSrc);
      }
    }

    for (const src of srcs) {
      // For this project, eager preloading both audio and video is acceptable (assets are small).
      // If you later add large videos, we can make this conditional by kind.
      const kind = guessKind(src);
      if (kind === 'video' || kind === 'audio') this.warm(src);
    }
  }
}

const mediaCache = new MediaCache();
export default mediaCache;
export { guessKind };
