import { Howl, Howler } from 'howler';
import type { TimelineEngine } from '@xzdarcy/react-timeline-editor';
import mediaCache from './mediaCache';

const inferHowlerFormat = (src: string): string | undefined => {
  if (!src) return undefined;
  const clean = src.split('#')[0].split('?')[0];
  const lower = clean.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = lower.slice(dot + 1);
  if (!ext) return undefined;

  // Howler expects format strings similar to file extensions.
  // Some extensions map to container formats.
  if (ext === 'm4a' || ext === 'm4v') return 'mp4';
  return ext;
};

const inferHowlerFormatFromMime = (mimeType: string): string | undefined => {
  const t = String(mimeType ?? '').toLowerCase();
  if (!t) return undefined;
  if (t === 'audio/mpeg' || t === 'audio/mp3') return 'mp3';
  if (t === 'audio/wav' || t === 'audio/x-wav') return 'wav';
  if (t === 'audio/ogg') return 'ogg';
  if (t === 'audio/aac') return 'aac';
  // Many browsers report m4a as audio/mp4.
  if (t === 'audio/mp4' || t === 'video/mp4') return 'mp4';
  return undefined;
};

const inferHowlerFormatForSrc = (src: string): string | undefined => {
  const direct = inferHowlerFormat(src);
  if (direct) return direct;
  const meta = mediaCache.getSrcMeta(src);
  const fromName = meta?.name ? inferHowlerFormat(meta.name) : undefined;
  if (fromName) return fromName;
  const fromMime = meta?.mimeType ? inferHowlerFormatFromMime(meta.mimeType) : undefined;
  if (fromMime) return fromMime;
  return undefined;
};

class AudioControl {
  private howlBySrc: Record<string, Howl> = {};
  private activeByActionId: Record<
    string,
    {
      src: string;
      startTime: number;
      offset: number;
      soundId: number;
      engine: TimelineEngine;
      lastResyncAtMs: number;
      time?: (data: { time: number }) => void;
      rate?: (data: { rate: number }) => void;
    }
  > = {};

  private getHowl(src: string): Howl {
    const resolved = mediaCache.resolve(src);
    // Prefer the resolved (often blob:) URL to avoid network stalls.
    // If it's a blob URL we must provide a format hint (filename/mimeType).
    const urlForHowler = resolved;
    const cacheKey = urlForHowler;
    if (this.howlBySrc[cacheKey]) return this.howlBySrc[cacheKey];

    const format = inferHowlerFormatForSrc(src) ?? inferHowlerFormatForSrc(resolved);
    const howl = new Howl({
      src: [urlForHowler],
      format: format ? [format] : undefined,
      loop: true,
      autoplay: false,
      preload: true,
    });
    this.howlBySrc[cacheKey] = howl;
    return howl;
  }

  /**
   * Ensure the underlying WebAudio context is resumed.
   *
   * Some browsers (notably iOS Safari) block audio playback until a user gesture
   * resumes the AudioContext. Timeline engine callbacks may occur outside the
   * original gesture call stack, so we explicitly unlock in the toolbar handler.
   */
  unlock() {
    try {
      const ctx = Howler.ctx;
      if (ctx && ctx.state === 'suspended') {
        void ctx.resume();
      }
    } catch {
      // ignore
    }
  }

  warm(src: string) {
    if (!src) return;
    mediaCache.warm(src);
    void this.getHowl(src);
  }

  private seekForEngineTime(howl: Howl, soundId: number, startTime: number, engineTime: number, offsetSeconds: number) {
    const rawOffset = Number(offsetSeconds);
    const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
    const duration = howl.duration();
    if (!Number.isFinite(duration) || duration <= 0) {
      howl.seek(Math.max(0, engineTime - startTime + offset), soundId);
      return;
    }
    const raw = (engineTime - startTime + offset) % duration;
    const position = raw < 0 ? raw + duration : raw;
    howl.seek(position, soundId);
  }

  start(data: { actionId: string; engine: TimelineEngine; src: string; startTime: number; time: number; offset?: number }) {
    const { actionId, src, startTime, time, engine } = data;
    const requestedOffset = Number(data.offset ?? 0);
    const offsetSeconds = Number.isFinite(requestedOffset) ? requestedOffset : 0;

    // If this action is already active, just re-sync.
    const existing = this.activeByActionId[actionId];
    if (existing) {
      const howl = this.getHowl(existing.src);
      howl.rate(engine.getPlayRate(), existing.soundId);

      // If the sound was stopped/never started for some reason, try to resume.
      try {
        if (!howl.playing(existing.soundId)) {
          howl.play(existing.soundId);
        }
      } catch {
        // ignore
      }

      // When scrubbing/paused, we do want immediate re-sync.
      if (!engine.isPlaying) {
        this.seekForEngineTime(howl, existing.soundId, existing.startTime, time, existing.offset);
      }
      return;
    }

    const howl = this.getHowl(src);
    const soundId = howl.play();
    howl.rate(engine.getPlayRate(), soundId);
    this.seekForEngineTime(howl, soundId, startTime, time, offsetSeconds);

    let lastResyncAtMs = performance.now();

    const timeListener = ({ time }: { time: number }) => {
      // When the timeline time is explicitly set (e.g. user drags/clicks cursor), we want
      // audio to jump immediately, even during playback.
      //
      // We still keep a light throttle for normal playback-driven updates to avoid
      // over-seeking (which can cause stutters on some browsers).
      const now = performance.now();
      if (!engine.isPlaying) {
        this.seekForEngineTime(howl, soundId, startTime, time, offsetSeconds);
        return;
      }

      // If time updates arrive frequently during playback, avoid seeking too often.
      if (now - lastResyncAtMs < 120) return;
      lastResyncAtMs = now;

      this.seekForEngineTime(howl, soundId, startTime, time, offsetSeconds);
    };
    const rateListener = ({ rate }: { rate: number }) => {
      howl.rate(rate, soundId);
    };

    engine.on('afterSetTime', timeListener);
    engine.on('afterSetPlayRate', rateListener);

    this.activeByActionId[actionId] = {
      src,
      startTime,
      offset: offsetSeconds,
      soundId,
      engine,
      lastResyncAtMs,
      time: timeListener,
      rate: rateListener,
    };
  }

  stop(data: { actionId: string }) {
    const { actionId } = data;
    const active = this.activeByActionId[actionId];
    if (!active) return;

    const howl = this.getHowl(active.src);
    try {
      howl.stop(active.soundId);
    } catch {
      // ignore
    }

    active.time && active.engine.off('afterSetTime', active.time);
    active.rate && active.engine.off('afterSetPlayRate', active.rate);
    delete this.activeByActionId[actionId];
  }
}

export default new AudioControl();