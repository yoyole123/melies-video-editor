import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { Button, Select } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { scale, scaleWidth, startLeft } from './mock';
import audioControl from './audioControl';
import videoControl from './videoControl';

const { Option } = Select;
export const Rates = [0.2, 0.5, 1.0, 1.5, 2.0];

const TimelinePlayer = ({
  timelineState,
  autoScrollWhenPlay,
  editorData,
  selectedActionId,
  onDeleteSelectedClip,
  onSplitSelectedClip,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  timelineState: React.MutableRefObject<TimelineState | null>;
  autoScrollWhenPlay: React.MutableRefObject<boolean>;
  editorData: any[];
  selectedActionId: string | null;
  onDeleteSelectedClip: () => void;
  onSplitSelectedClip: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const lastUiUpdateAt = useRef(0);
  const lastToggleAt = useRef(0);
  const lastDeleteAt = useRef(0);
  const lastSplitAt = useRef(0);
  const lastUndoAt = useRef(0);
  const lastRedoAt = useRef(0);

  const canDelete = Boolean(selectedActionId);

  const getSelectedActionRange = () => {
    if (!selectedActionId) return null;
    const rows = Array.isArray(editorData) ? editorData : [];
    for (const row of rows) {
      const actions = (row as any)?.actions;
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        if (String((action as any)?.id) !== selectedActionId) continue;
        const start = Number((action as any)?.start);
        const end = Number((action as any)?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        return { start, end };
      }
    }
    return null;
  };

  const selectedRange = getSelectedActionRange();
  const canSplit = Boolean(selectedRange && time > selectedRange.start && time < selectedRange.end);

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
      // Must be called inside a user gesture on some browsers.
      audioControl.unlock();
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

  const collectUniqueAssetSrcs = () => {
    const out: string[] = [];
    const seen = new Set<string>();
    const rows = Array.isArray(editorData) ? editorData : [];
    for (const row of rows) {
      const actions = (row as any)?.actions;
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        const src = (action as any)?.data?.src;
        if (!src) continue;
        const key = String(src);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 3_000);
  };

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const srcs = collectUniqueAssetSrcs();
      const form = new FormData();
      form.append('timeline', JSON.stringify({ editorData }));

      for (const src of srcs) {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(`Failed to fetch asset: ${src} (${resp.status})`);
        const blob = await resp.blob();
        form.append('assets', blob, encodeURIComponent(src));
      }

      const resp = await fetch('/export', {
        method: 'POST',
        body: form,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `Export failed (${resp.status})`);
      }

      const blob = await resp.blob();
      downloadBlob(blob, 'export.mp4');
    } finally {
      setIsExporting(false);
    }
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

      <div className="history-tools">
        <button
          type="button"
          className="history-tool"
          disabled={!canUndo}
          aria-label="Undo"
          onClick={() => {
            if (Date.now() - lastUndoAt.current < 450) return;
            if (!canUndo) return;
            onUndo();
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') return;
            lastUndoAt.current = Date.now();
            if (!canUndo) return;
            onUndo();
          }}
        >
          <img src="/undo.png" alt="" draggable={false} />
        </button>

        <button
          type="button"
          className="history-tool"
          disabled={!canRedo}
          aria-label="Redo"
          onClick={() => {
            if (Date.now() - lastRedoAt.current < 450) return;
            if (!canRedo) return;
            onRedo();
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') return;
            lastRedoAt.current = Date.now();
            if (!canRedo) return;
            onRedo();
          }}
        >
          <img src="/redo.png" alt="" draggable={false} />
        </button>
      </div>

      <div className="rate-control">
        <Select size={'small'} defaultValue={1} style={{ width: 120 }} onChange={handleRateChange}>
          {Rates.map((rate) => (
            <Option key={rate} value={rate}>{`${rate.toFixed(1)}x`}</Option>
          ))}
        </Select>
      </div>

      <div className="clip-tools">
        <button
          type="button"
          className="clip-tool clip-tool-delete"
          disabled={!canDelete}
          aria-label="Delete selected clip"
          onClick={() => {
            // Mobile browsers often fire a synthetic click after touch.
            // If we've just handled a touch/pen pointer event, ignore the click.
            if (Date.now() - lastDeleteAt.current < 450) return;
            if (!canDelete) return;
            onDeleteSelectedClip();
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') return;
            lastDeleteAt.current = Date.now();
            if (!canDelete) return;
            onDeleteSelectedClip();
          }}
        >
          <img src="/bin.png" alt="" draggable={false} />
        </button>

        <button
          type="button"
          className="clip-tool clip-tool-split"
          disabled={!canSplit}
          aria-label="Split selected clip at cursor"
          onClick={() => {
            if (Date.now() - lastSplitAt.current < 450) return;
            if (!canSplit) return;
            onSplitSelectedClip();
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') return;
            lastSplitAt.current = Date.now();
            if (!canSplit) return;
            onSplitSelectedClip();
          }}
        >
          <img src="/split.png" alt="" draggable={false} />
        </button>
      </div>

      <div className="export-control">
        <Button size="small" type="primary" loading={isExporting} onClick={handleExport}>
          Export
        </Button>
      </div>
    </div>
  );
};

export default TimelinePlayer;