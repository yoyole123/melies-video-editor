import { Howl } from 'howler';
import { TimelineEngine } from '@xzdarcy/react-timeline-editor';
import mediaCache from './mediaCache';

class AudioControl {
  private howlBySrc: Record<string, Howl> = {};
  private activeByActionId: Record<
    string,
    {
      src: string;
      startTime: number;
      soundId: number;
      engine: TimelineEngine;
      time?: (data: { time: number }) => void;
      rate?: (data: { rate: number }) => void;
    }
  > = {};

  private getHowl(src: string): Howl {
    const resolved = mediaCache.resolve(src);
    if (this.howlBySrc[resolved]) return this.howlBySrc[resolved];
    const howl = new Howl({ src: [resolved], loop: true, autoplay: false, preload: true });
    this.howlBySrc[resolved] = howl;
    return howl;
  }

  warm(src: string) {
    if (!src) return;
    mediaCache.warm(src);
    void this.getHowl(src);
  }

  private seekForEngineTime(howl: Howl, soundId: number, startTime: number, engineTime: number) {
    const duration = howl.duration();
    if (!Number.isFinite(duration) || duration <= 0) {
      howl.seek(Math.max(0, engineTime - startTime), soundId);
      return;
    }
    const raw = (engineTime - startTime) % duration;
    const offset = raw < 0 ? raw + duration : raw;
    howl.seek(offset, soundId);
  }

  start(data: { actionId: string; engine: TimelineEngine; src: string; startTime: number; time: number }) {
    const { actionId, src, startTime, time, engine } = data;

    // If this action is already active, just re-sync.
    const existing = this.activeByActionId[actionId];
    if (existing) {
      const howl = this.getHowl(existing.src);
      howl.rate(engine.getPlayRate(), existing.soundId);
      this.seekForEngineTime(howl, existing.soundId, existing.startTime, time);
      return;
    }

    const howl = this.getHowl(src);
    const soundId = howl.play();
    howl.rate(engine.getPlayRate(), soundId);
    this.seekForEngineTime(howl, soundId, startTime, time);

    const timeListener = ({ time }: { time: number }) => {
      this.seekForEngineTime(howl, soundId, startTime, time);
    };
    const rateListener = ({ rate }: { rate: number }) => {
      howl.rate(rate, soundId);
    };

    engine.on('afterSetTime', timeListener);
    engine.on('afterSetPlayRate', rateListener);

    this.activeByActionId[actionId] = {
      src,
      startTime,
      soundId,
      engine,
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