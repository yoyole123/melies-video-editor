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

  /**
   * Preloads a URL into memory and returns a blob: URL.
   * Useful to avoid runtime buffering/stalls when seeking frequently.
   */
  async preloadToBlobUrl(src: string): Promise<string> {
    if (!src) return src;
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
    void this.preloadToBlobUrl(src);
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
        if (typeof src === 'string' && src) srcs.add(src);
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
