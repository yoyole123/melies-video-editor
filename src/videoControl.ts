import mediaCache from './mediaCache';
import type { TimelineAction, TimelineEngine, TimelineRow } from '@xzdarcy/react-timeline-editor';

/**
 * Extended action interface to match CustomTimelineAction in mock.ts
 */
interface CustomActionData {
  src: string;
  previewSrc?: string;
  videoLayer?: number;
  offset?: number;
}

interface QueuedClip {
  actionId: string;
  src: string;
  start: number;
  end: number;
  offset: number;
  layer: number;
}

class VideoControl {
  // Dual-buffer elements
  private primaryEl: HTMLVideoElement | null = null;
  private secondaryEl: HTMLVideoElement | null = null;
  
  // Track which element is currently "active" (visible and driving time)
  private activeEl: HTMLVideoElement | null = null;

  // The full timeline data, needed for lookahead
  private rowData: TimelineRow[] = [];

  // Engine binding
  private boundEngine: TimelineEngine | null = null;
  private boundActionStart = 0; // Not strictly used in global-time mode but kept for compat
  
  // Frame loop handles
  private vfcHandle: number | null = null;
  private rafHandle: number | null = null;

  // State tracking
  private isPlaying = false;
  private playbackRate = 1;
  private currentClipId: string | null = null; // apparent clip ID
  private lastVideoClip: QueuedClip | null = null;
  
  // If the user manually seeks, we need to invalidate preloads
  private lastKnownTime = 0;

  constructor() {
    this.tickLoop = this.tickLoop.bind(this);
  }

  /**
   * Called by App.tsx to provide the two video elements.
   */
  attachPrimary(el: HTMLVideoElement | null) {
    this.primaryEl = el;
    this.initElement(el);
  }

  attachSecondary(el: HTMLVideoElement | null) {
    this.secondaryEl = el;
    this.initElement(el);
  }

  /**
   * Helper to set initial styling/events for video elements.
   */
  private initElement(el: HTMLVideoElement | null) {
    if (!el) return;
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.objectFit = 'contain';
    el.style.opacity = '0'; // Start hidden
    el.preload = 'auto'; // Ensure browser tries to load
  }

  /**
   * Deprecated single-element attach, mapped to primary for safety.
   */
  attach(el: HTMLVideoElement | null) {
    this.attachPrimary(el);
  }

  /**
   * Called by App.tsx whenever timeline data changes.
   */
  setEditorData(data: TimelineRow[]) {
    this.rowData = data;
    // If we are paused, we might need to re-evaluate the current frame.
    // But usually the engine will trigger a seek/time-update logic.
  }

  /**
   * We use claimVideo to drive the dual-buffer logic from the engine's time updates.
   * This ensures we sync to the engine's clock (Slave Mode).
   */
  claimVideo(data: { isPlaying?: boolean; time?: number }) {
    this.isPlaying = Boolean(data.isPlaying);
    const time = Number(data.time);
    if (Number.isFinite(time)) {
       // Check if we need to bind strictly to engine? 
       // For now, just update our state based on the time reported by the engine.
       this.lastKnownTime = time;
       this.updateState(time);
    }
  }

  bindEngine(engine: TimelineEngine) {
    this.unbindEngine();
    this.boundEngine = engine;
    
    // Start the loop!
    this.startLoop();
  }

  unbindEngine() {
    this.stopLoop();
    this.boundEngine = null;
  }

  private startLoop() {
    if (this.rafHandle || this.vfcHandle) return;
    this.tickLoop();
  }

  private stopLoop() {
    if (this.vfcHandle && this.activeEl?.cancelVideoFrameCallback) {
      this.activeEl.cancelVideoFrameCallback(this.vfcHandle);
    }
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
    }
    this.vfcHandle = null;
    this.rafHandle = null;
  }

  /**
   * The main heart beat. 
   * - If playing: sync engine time to video time.
   * - Always: Check schedule (what should be playing vs preloading).
   */
  private tickLoop() {
    if (!this.boundEngine) return;

    // Engine time is authoritative. Video follows the timeline, never the other way around.
    const engineTime = this.boundEngine.getTime();
    this.lastKnownTime = engineTime;

    // 2. Scheduler Logic: Determine what SHOULD be visible and what should be PRELOADED.
    this.updateState(this.lastKnownTime);

    // 3. Schedule next tick
    // Always use RAF to ensure we keep polling the engine even when video is paused/hidden/gap.
    // Relying on video.rVFC is dangerous if video pauses or hides.
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.tickLoop();
    });
  }

  /**
   * Evaluate the timeline at `time` (and `time + lookahead`).
   * Manage Primary/Secondary elements.
   */
  private updateState(time: number) {
    if (!this.primaryEl || !this.secondaryEl) return;

    // A. Identify current clip
    const currentClip = this.findClipAtTime(time);
    // Prefer near-future clip for seamless transitions. If none, preload the next upcoming clip.
    const lookaheadTime = time + 0.5; // 500ms
    let nextClip = this.findClipAtTime(lookaheadTime);
    if (!nextClip || (currentClip && nextClip.actionId === currentClip.actionId)) {
      nextClip = this.findNextVideoClipAfter(time);
    }

    // B. Handle Visibility / Active assignment
    if (currentClip) {
      // We need to show this clip.
      // Is it already on Primary?
      if (this.isLoaded(this.primaryEl, currentClip.src)) {
        this.makeActive(this.primaryEl, currentClip, time);
      } 
      // Is it on Secondary?
      else if (this.isLoaded(this.secondaryEl, currentClip.src)) {
        this.makeActive(this.secondaryEl, currentClip, time);
      } 
      // Neither? Load into Primary (default).
      else {
        // Emergency load
        this.loadVideo(this.primaryEl, currentClip.src);
        this.makeActive(this.primaryEl, currentClip, time);
      }
      this.currentClipId = currentClip.actionId;
      this.lastVideoClip = currentClip;
    } else {
      // GAP HANDLING
      // If the gap is smaller than 0.1s and we have a previous clip, freeze on its last frame.
      // Otherwise, show black.
      const nextStart = this.findNextVideoClipStartAfter(time);
      const isMicroGap =
        nextStart != null &&
        nextStart - time > 0 &&
        nextStart - time <= 0.1 &&
        this.lastVideoClip != null &&
        time - this.lastVideoClip.end >= 0 &&
        time - this.lastVideoClip.end <= 0.1 &&
        this.activeEl != null;

      if (isMicroGap) {
        // Keep the last visible video, but STOP it and clamp to the last frame of the clip.
        const endTime = Math.max(
          0,
          (this.lastVideoClip!.end - this.lastVideoClip!.start) + this.lastVideoClip!.offset - 0.02
        );

        // Hide the other element, keep active visible.
        const other = this.activeEl === this.primaryEl ? this.secondaryEl : this.primaryEl;
        other.style.opacity = '0';
        this.activeEl.style.opacity = '1';

        try {
          if (!this.activeEl.paused) this.activeEl.pause();
          const duration = this.activeEl.duration;
          if (Number.isFinite(duration) && duration > 0) {
            this.activeEl.currentTime = Math.min(endTime, Math.max(0, duration - 0.05));
          } else {
            this.activeEl.currentTime = Math.max(0, endTime);
          }
        } catch {
          // ignore
        }
      } else {
        // Macro gap: show black (no video underneath cursor).
        this.primaryEl.style.opacity = '0';
        this.secondaryEl.style.opacity = '0';

        this.activeEl = null;
        this.currentClipId = null;

        // Ensure they stop processing immediately.
        if (!this.primaryEl.paused) this.primaryEl.pause();
        if (!this.secondaryEl.paused) this.secondaryEl.pause();
      }
    }

    // C. Handle Preloading (Standby)
    // Only preload if nextClip is different from currentClip
    if (nextClip && (!currentClip || nextClip.actionId !== currentClip.actionId)) {
      // Which element is free? (Not active)
      const freeEl = this.primaryEl === this.activeEl ? this.secondaryEl : this.primaryEl;
      
      // Load next clip into free element if not already loaded
      if (freeEl && !this.isLoaded(freeEl, nextClip.src)) {
        this.loadVideo(freeEl, nextClip.src);
        // Pre-seek to start offset
        freeEl.currentTime = nextClip.offset;
        // If we are playing, maybe we want to play() and pause() to warm up decoder?
        // For now, simply setting src and currentTime is often enough for 'auto' preload.
      }
    }
  }

  private makeActive(el: HTMLVideoElement, clip: QueuedClip, globalTime: number) {
    // 1. Set Visibilty
    const other = el === this.primaryEl ? this.secondaryEl : this.primaryEl;
    if (other) other.style.opacity = '0'; // Hide other
    el.style.opacity = '1'; // Show this
    this.activeEl = el;

    // 2. Sync Time (Seek if drifted)
    // Target video time = (globalTime - clip.start) + clip.offset
    const targetTime = Math.max(0, (globalTime - clip.start) + clip.offset);
    const drift = Math.abs(el.currentTime - targetTime);

    // If drift is large, seek. (Tolerate ~50ms drift during playback)
    if (drift > 0.05) {
       el.currentTime = targetTime;
    }

    // 3. Play/Pause state
    if (this.isPlaying) {
      if (el.paused) {
        el.play().catch(() => {});
        el.playbackRate = this.playbackRate;
      }
    } else {
      if (!el.paused) {
        el.pause();
      }
    }
  }

  private loadVideo(el: HTMLVideoElement, src: string) {
    const resolved = mediaCache.resolve(src);
    // Avoid reloading if same
    if (el.getAttribute('data-src-url') === resolved) return;

    el.src = resolved;
    el.setAttribute('data-src-url', resolved);
    el.load();
  }

  private isLoaded(el: HTMLVideoElement, src: string) {
    const resolved = mediaCache.resolve(src);
    return el.getAttribute('data-src-url') === resolved;
  }

  private findClipAtTime(time: number): QueuedClip | null {
    // Basic linear search - for small timelines this is fine.
    // Optimization: cache sorted clips?
    
    // Using a tiny epsilon for quantization robustness?
    // time = Math.round(time * 1000) / 1000;

    const candidates: QueuedClip[] = [];

    for (const row of this.rowData) {
      for (const action of row.actions as TimelineAction[]) {
        if ((action as TimelineAction & { effectId?: string }).effectId !== 'effect1') continue;
        // Check intersection
        if (time >= action.start && time < action.end) {
          // It's a candidate.
          const data = (action as unknown as { data?: CustomActionData }).data;
          const chosen = data?.previewSrc || data?.src;
          if (chosen) {
             candidates.push({
               actionId: action.id,
               src: chosen,
               start: action.start,
               end: action.end,
               offset: Number(data.offset) || 0,
               layer: Number(data.videoLayer) || 0
             });
          }
        }
      }
    }

    if (candidates.length === 0) return null;

    // Sort by layer (descending), then start time?
    // Usually higher layer wins.
    return candidates.sort((a, b) => b.layer - a.layer)[0];
  }

  private findNextVideoClipStartAfter(time: number): number | null {
    let bestStart: number | null = null;
    let bestLayer = -Infinity;
    for (const row of this.rowData) {
      for (const action of row.actions as TimelineAction[]) {
        if ((action as TimelineAction & { effectId?: string }).effectId !== 'effect1') continue;
        const start = Number(action.start);
        if (!Number.isFinite(start)) continue;
        if (start <= time) continue;
        const data = (action as unknown as { data?: CustomActionData }).data;
        const chosen = data?.previewSrc || data?.src;
        if (!chosen) continue;
        const layer = Number(data?.videoLayer) || 0;
        if (bestStart == null || start < bestStart) {
          bestStart = start;
          bestLayer = layer;
          continue;
        }
        if (start === bestStart && layer > bestLayer) {
          bestLayer = layer;
        }
      }
    }
    return bestStart;
  }

  private findNextVideoClipAfter(time: number): QueuedClip | null {
    let best: QueuedClip | null = null;
    for (const row of this.rowData) {
      for (const action of row.actions as TimelineAction[]) {
        if ((action as TimelineAction & { effectId?: string }).effectId !== 'effect1') continue;
        const start = Number(action.start);
        const end = Number(action.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (start <= time) continue;
        const data = (action as unknown as { data?: CustomActionData }).data;
        const chosen = data?.previewSrc || data?.src;
        if (!chosen) continue;
        const layer = Number(data?.videoLayer) || 0;
        const candidate: QueuedClip = {
          actionId: action.id,
          src: chosen,
          start,
          end,
          offset: Number(data?.offset) || 0,
          layer,
        };
        if (!best) {
          best = candidate;
          continue;
        }
        if (candidate.start < best.start) {
          best = candidate;
          continue;
        }
        if (candidate.start === best.start && candidate.layer > best.layer) {
          best = candidate;
        }
      }
    }
    return best;
  }

  // PUBLIC API for App/Action interactions

  play() {
    this.isPlaying = true;
    if (this.activeEl?.paused) {
      this.activeEl.play().catch(() => {});
    }
  }

  pause() {
    this.isPlaying = false;
    this.activeEl?.pause();
    this.secondaryEl?.pause();
    this.primaryEl?.pause();
  }

  setRate(rate: number) {
    this.playbackRate = rate;
    if (this.activeEl) this.activeEl.playbackRate = rate;
  }

  // Seek is handled by engine updating time, which allows updateState to react.
  // Optional: manual seek method if needed
  seek(time: number) {
     this.lastKnownTime = time;
     this.updateState(time);
     // Force sync
     if (this.activeEl) {
        // ... handled in updateState
     }
  }

  // Utilities
  warm(src: string) {
    mediaCache.warm(src);
  }

  // Legacy/Compatibility methods
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  releaseVideo(_actionId: string) {
    // No-op: State is managed by polling editorData and engine time.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setActive(_active: boolean) {
    // No-op: Visibility is managed by updateState().
  }

  /**
   * Returns the active (visible) video element, if any.
   * Useful for UI-level logic that needs to wait for buffering after a seek.
   */
  getActiveVideoElement(): HTMLVideoElement | null {
    return this.activeEl;
  }

  /**
   * Checks whether a video has at least `minSecondsAhead` buffered at its current time.
   *
   * Note: buffered ranges are in media time, not timeline time.
   */
  private hasBufferedAhead(el: HTMLVideoElement, minSecondsAhead: number): boolean {
    const minAhead = Math.max(0, Number(minSecondsAhead) || 0);
    const t = Number(el.currentTime);
    if (!Number.isFinite(t)) return false;

    try {
      const ranges = el.buffered;
      for (let i = 0; i < ranges.length; i++) {
        const start = ranges.start(i);
        const end = ranges.end(i);
        if (t >= start && t <= end) {
          return end - t >= minAhead;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  /**
   * Waits until the active element appears ready for smooth playback after a seek.
   * Returns true if the readiness criteria is met before timing out.
   */
  async waitForActiveBufferedAhead(opts?: {
    minSecondsAhead?: number;
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<boolean> {
    const minSecondsAhead = Math.max(0, Number(opts?.minSecondsAhead) || 0);
    const timeoutMs = Math.max(0, Number(opts?.timeoutMs) || 0);
    const pollMs = Math.max(10, Number(opts?.pollMs) || 50);
    const startAt = performance.now();

    while (performance.now() - startAt <= timeoutMs) {
      const el = this.activeEl;
      // If there's no active video under the cursor (black/gap), there's nothing to buffer.
      if (!el) return true;

      // We want at least current data (ideally future data) and no in-flight seek.
      const ready = el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      const settled = !el.seeking;
      const buffered = minSecondsAhead <= 0 ? true : this.hasBufferedAhead(el, minSecondsAhead);

      if (ready && settled && buffered) return true;

      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), pollMs);
      });
    }

    return false;
  }
}

export default new VideoControl();
