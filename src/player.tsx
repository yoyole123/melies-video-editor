import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { Select } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { scale, scaleWidth, startLeft } from './mock';
import videoControl from './videoControl';

const { Option } = Select;
export const Rates = [0.2, 0.5, 1.0, 1.5, 2.0];

const TimelinePlayer = ({
  timelineState,
  autoScrollWhenPlay,
  editorData,
}: {
  timelineState: React.MutableRefObject<TimelineState | null>;
  autoScrollWhenPlay: React.MutableRefObject<boolean>;
  editorData: any[];
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const lastUiUpdateAt = useRef(0);
  const lastToggleAt = useRef(0);

  const isTimeOverVideo = (t: number) => {
    const rows = Array.isArray(editorData) ? editorData : [];
    for (const row of rows) {
      const actions = (row as any)?.actions;
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        // In this app, video actions use effectId === 'effect1'
        if ((action as any)?.effectId !== 'effect1') continue;
        const start = Number((action as any)?.start);
        const end = Number((action as any)?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        // Exclusive end: at exact end, treat as no-video (black) unless next clip starts.
        if (t >= start && t < end) return true;
      }
    }
    return false;
  };

  const syncBlackFrame = (t: number) => {
    const overVideo = isTimeOverVideo(t);
    if (!overVideo) {
      // Defensive: ensure preview is black between clips even if a leave callback is missed.
      videoControl.pause();
      videoControl.unbindEngine();
      videoControl.setActive(false);
    }
  };

  useEffect(() => {
    if (!timelineState.current) return;
    const engine = timelineState.current;
    const onPlay = () => setIsPlaying(true);
    const onPaused = () => setIsPlaying(false);
    const onAfterSetTime = ({ time }: { time: number }) => {
      setTime(time);
      syncBlackFrame(time);
    };
    const onSetTimeByTick = ({ time }: { time: number }) => {
      const now = performance.now();
      // Limit UI work to ~30fps during playback.
      if (now - lastUiUpdateAt.current < 33) return;
      lastUiUpdateAt.current = now;

      setTime(time);
      syncBlackFrame(time);

      if (autoScrollWhenPlay.current) {
        const autoScrollFrom = 500;
        const left = time * (scaleWidth / scale) + startLeft - autoScrollFrom;
        const state = timelineState.current;
        if (state) state.setScrollLeft(left);
      }
    };

    engine.listener.on('play', onPlay);
    engine.listener.on('paused', onPaused);
    engine.listener.on('afterSetTime', onAfterSetTime);
    engine.listener.on('setTimeByTick', onSetTimeByTick);

    return () => {
      // IMPORTANT: do NOT call offAll() here.
      // Timeline itself uses the same emitter; offAll would break cursor updates.
      engine.listener.off('play', onPlay);
      engine.listener.off('paused', onPaused);
      engine.listener.off('afterSetTime', onAfterSetTime);
      engine.listener.off('setTimeByTick', onSetTimeByTick);
    };
  }, [editorData]);

  // Start or pause
  const handlePlayOrPause = () => {
    if (!timelineState.current) return;
    if (timelineState.current.isPlaying) {
      timelineState.current.pause();
    } else {
      timelineState.current.play({ autoEnd: true });
    }
  };

  // Set playback rate
  const handleRateChange = (rate: number) => {
    if (!timelineState.current) return;
    timelineState.current.setPlayRate(rate);
  };

  // Time display
  const timeRender = (time: number) => {
    const float = (parseInt((time % 1) * 100 + '') + '').padStart(2, '0');
    const min = (parseInt(time / 60 + '') + '').padStart(2, '0');
    const second = (parseInt((time % 60) + '') + '').padStart(2, '0');
    return <>{`${min}:${second}.${float.replace('0.', '')}`}</>;
  };

  return (
    <div className="timeline-player">
      <div
        className="play-control"
        role="button"
        tabIndex={0}
        onClick={() => {
          // Mobile browsers often fire a synthetic click after touch.
          // If we've just handled a touch/pen pointer event, ignore the click.
          if (Date.now() - lastToggleAt.current < 450) return;
          handlePlayOrPause();
        }}
        onPointerUp={(e) => {
          if (e.pointerType === 'mouse') return;
          lastToggleAt.current = Date.now();
          handlePlayOrPause();
        }}
      >
        {isPlaying ? '||' : '▶'}
      </div>
      <div className="time">{timeRender(time)}</div>
      <div className="rate-control">
        <Select size={'small'} defaultValue={1} style={{ width: 120 }} onChange={handleRateChange}>
          {Rates.map((rate) => (
            <Option key={rate} value={rate}>{`${rate.toFixed(1)}x`}</Option>
          ))}
        </Select>
      </div>
    </div>
  );
};

export default TimelinePlayer;