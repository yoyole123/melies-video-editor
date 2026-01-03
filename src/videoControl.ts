import mediaCache from './mediaCache';
import type { TimelineEngine } from '@xzdarcy/react-timeline-editor';

class VideoControl {
  private videoEl: HTMLVideoElement | null = null;
  private currentSrc: string | null = null;
  private lastSeekAtMs = 0;
  private lastRate: number | null = null;

  private videoClaims: Record<
    string,
    {
      actionId: string;
      layer: number;
      src: string;
      actionStart: number;
      offset: number;
      engine: TimelineEngine;
      isPlaying: boolean;
      time: number;
      claimedAtMs: number;
    }
  > = {};
  private activeVideoActionId: string | null = null;
  private lastEngineTime: number = 0;

  private boundEngine: TimelineEngine | null = null;
  private boundActionStart = 0;
  private vfcHandle: number | null = null;
  private rafHandle: number | null = null;

  attach(el: HTMLVideoElement | null) {
    this.videoEl = el;
    // Reset currentSrc when re-attaching to avoid stale comparisons.
    this.currentSrc = el?.currentSrc || el?.getAttribute('src') || null;
    this.lastSeekAtMs = 0;
    this.lastRate = null;
    this.unbindEngine();

    // Clear any overlapping-video arbitration state.
    this.videoClaims = {};
    this.activeVideoActionId = null;
    this.lastEngineTime = 0;

    // Default to inactive (black) until a video action becomes active.
    this.setActive(false);
  }

  setActive(active: boolean) {
    if (!this.videoEl) return;
    // Show black when inactive by hiding the video element.
    this.videoEl.style.opacity = active ? '1' : '0';
  }

  claimVideo(data: {
    actionId: string;
    layer: number;
    src: string;
    engine: TimelineEngine;
    isPlaying: boolean;
    time: number;
    actionStart: number;
    offset?: number;
  }) {
    const actionId = String(data.actionId);
    const layer = Number.isFinite(Number(data.layer)) ? Number(data.layer) : 0;
    const src = String(data.src ?? '');
    const actionStart = Number(data.actionStart);
    const time = Number(data.time);
    const engine = data.engine;
    const isPlaying = Boolean(data.isPlaying);
    const rawOffset = Number(data.offset ?? 0);
    const offset = Number.isFinite(rawOffset) ? rawOffset : 0;

    if (!src) return;
    if (!Number.isFinite(actionStart) || !Number.isFinite(time)) return;

    const now = performance.now();
    this.lastEngineTime = time;
    this.videoClaims[actionId] = {
      actionId,
      layer,
      src,
      actionStart,
      offset,
      engine,
      isPlaying,
      time,
      claimedAtMs: now,
    };

    // Pick winner: highest layer wins (V2 over V1). Tie-breaker: most recently claimed.
    let winner: (typeof this.videoClaims)[string] | null = null;
    for (const claim of Object.values(this.videoClaims)) {
      if (!winner) {
        winner = claim;
        continue;
      }
      if (claim.layer > winner.layer) {
        winner = claim;
        continue;
      }
      if (claim.layer === winner.layer && claim.claimedAtMs > winner.claimedAtMs) {
        winner = claim;
      }
    }
    if (!winner) return;

    // Apply winner to the actual <video>.
    this.activeVideoActionId = winner.actionId;
    this.setActive(true);
    this.setRate(winner.engine.getPlayRate());
    this.setSource(winner.src);
    const desired = Math.max(0, winner.time - winner.actionStart + winner.offset);
    this.seek(desired, { force: !winner.isPlaying });
    if (winner.isPlaying) {
      void this.play();
    } else {
      this.pause();
    }
  }

  releaseVideo(actionIdRaw: string) {
    const actionId = String(actionIdRaw);
    delete this.videoClaims[actionId];

    // If the leaving clip wasn't the active one, no-op.
    if (this.activeVideoActionId && this.activeVideoActionId !== actionId) return;

    // Recompute winner.
    let winner: (typeof this.videoClaims)[string] | null = null;
    for (const claim of Object.values(this.videoClaims)) {
      if (!winner) {
        winner = claim;
        continue;
      }
      if (claim.layer > winner.layer) {
        winner = claim;
        continue;
      }
      if (claim.layer === winner.layer && claim.claimedAtMs > winner.claimedAtMs) {
        winner = claim;
      }
    }

    if (!winner) {
      this.activeVideoActionId = null;
      this.pause();
      this.unbindEngine();
      this.setActive(false);
      return;
    }

    this.activeVideoActionId = winner.actionId;
    this.setActive(true);
    this.setRate(winner.engine.getPlayRate());
    this.setSource(winner.src);
    const desired = Math.max(0, this.lastEngineTime - winner.actionStart + winner.offset);
    this.seek(desired, { force: !winner.isPlaying });
    if (winner.isPlaying) {
      void this.play();
    } else {
      this.pause();
    }
  }

  bindEngine(engine: TimelineEngine, actionStart: number) {
    this.unbindEngine();
    this.boundEngine = engine;
    this.boundActionStart = actionStart;
    this.tickFromVideo();
  }

  unbindEngine() {
    const v: any = this.videoEl;
    if (this.vfcHandle != null && v?.cancelVideoFrameCallback) {
      try {
        v.cancelVideoFrameCallback(this.vfcHandle);
      } catch {
        // ignore
      }
    }
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
    }
    this.vfcHandle = null;
    this.rafHandle = null;
    this.boundEngine = null;
  }

  private tickFromVideo = () => {
    if (!this.videoEl || !this.boundEngine) return;
    if (this.videoEl.paused) return;

    const t = this.boundActionStart + this.videoEl.currentTime;
    // Deadzone to reduce event spam.
    if (Math.abs(this.boundEngine.getTime() - t) > 0.03) {
      // Mark as tick-driven so listeners treat it like playback.
      this.boundEngine.setTime(t, true);
    }

    const v: any = this.videoEl;
    if (v?.requestVideoFrameCallback) {
      this.vfcHandle = v.requestVideoFrameCallback(() => this.tickFromVideo());
    } else {
      this.rafHandle = requestAnimationFrame(() => this.tickFromVideo());
    }
  };

  setSource(src: string) {
    if (!this.videoEl) return;
    if (!src) return;

    // Prefer preloaded blob URLs when available.
    const resolved = mediaCache.resolve(src);

    // If React isn't controlling src, we can swap it here.
    // Use both currentSrc and attribute src checks to avoid redundant reloads.
    const existing = this.videoEl.currentSrc || this.videoEl.getAttribute('src') || '';
    if (existing === resolved || this.currentSrc === resolved) return;

    this.currentSrc = resolved;
    this.videoEl.preload = 'auto';
    this.videoEl.src = resolved;
    try {
      this.videoEl.load();
    } catch {
      // ignore
    }
  }

  warm(src: string) {
    if (!src) return;
    mediaCache.warm(src);
  }

  setRate(rate: number) {
    if (!this.videoEl) return;
    if (this.lastRate === rate) return;
    this.lastRate = rate;
    this.videoEl.playbackRate = rate;
  }

  /**
   * Sync the video to a desired timeline time.
   * To avoid buffering/stutters, we only seek when drift is large or when paused/scrubbing.
   */
  seek(time: number, opts?: { force?: boolean }) {
    if (!this.videoEl) return;
    try {
      const now = performance.now();
      const force = opts?.force === true;
      const current = this.videoEl.currentTime;

      // While playing, avoid frequent tiny seeks (these can trigger buffering).
      if (!force && !this.videoEl.paused) {
        const drift = Math.abs(current - time);
        if (drift < 0.12) return;
        if (now - this.lastSeekAtMs < 150) return;
      }

      const duration = this.videoEl.duration;
      if (Number.isFinite(duration) && duration > 0) {
        this.videoEl.currentTime = Math.min(time, Math.max(0, duration - 0.05));
      } else {
        this.videoEl.currentTime = Math.max(0, time);
      }

      this.lastSeekAtMs = now;
    } catch {
      // ignore
    }
  }

  async play() {
    if (!this.videoEl) return;
    try {
      await this.videoEl.play();
      // If bound, start ticking engine from video frames.
      if (this.boundEngine) this.tickFromVideo();
    } catch {
      // Autoplay restrictions can block play() until user gesture.
    }
  }

  pause() {
    if (!this.videoEl) return;
    this.videoEl.pause();
  }
}

export default new VideoControl();
