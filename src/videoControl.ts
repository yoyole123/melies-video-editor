class VideoControl {
  private videoEl: HTMLVideoElement | null = null;

  attach(el: HTMLVideoElement | null) {
    this.videoEl = el;
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
