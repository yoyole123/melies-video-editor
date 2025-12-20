class VideoControl {
  private videoEl: HTMLVideoElement | null = null;
  private currentSrc: string | null = null;

  attach(el: HTMLVideoElement | null) {
    this.videoEl = el;
    // Reset currentSrc when re-attaching to avoid stale comparisons.
    this.currentSrc = el?.currentSrc || el?.getAttribute('src') || null;
  }

  setSource(src: string) {
    if (!this.videoEl) return;
    if (!src) return;

    // If React isn't controlling src, we can swap it here.
    // Use both currentSrc and attribute src checks to avoid redundant reloads.
    const existing = this.videoEl.currentSrc || this.videoEl.getAttribute('src') || '';
    if (existing === src || this.currentSrc === src) return;

    this.currentSrc = src;
    this.videoEl.src = src;
    try {
      this.videoEl.load();
    } catch {
      // ignore
    }
  }

  setRate(rate: number) {
    if (!this.videoEl) return;
    this.videoEl.playbackRate = rate;
  }

  seek(time: number) {
    if (!this.videoEl) return;
    try {
      const duration = this.videoEl.duration;
      if (Number.isFinite(duration) && duration > 0) {
        this.videoEl.currentTime = Math.min(time, Math.max(0, duration - 0.05));
      } else {
        this.videoEl.currentTime = Math.max(0, time);
      }
    } catch {
      // ignore
    }
  }

  async play() {
    if (!this.videoEl) return;
    try {
      await this.videoEl.play();
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
