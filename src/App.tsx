import { Timeline } from '@xzdarcy/react-timeline-editor';
import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { useEffect, useRef, useState } from 'react';
import { CustomRender0, CustomRender1 } from './custom';
import './index.less';
import { mockData, mockEffect, scale, scaleWidth, startLeft } from './mock';
import type { CustomTimelineAction, CusTomTimelineRow } from './mock';
import { FOOTAGE_BIN } from './footageBin';
import TimelinePlayer from './player';
import videoControl from './videoControl';
import mediaCache from './mediaCache';
import { useCoarsePointer } from './useCoarsePointer';

const defaultEditorData = structuredClone(mockData);

const TimelineEditor = () => {
  const [data, setData] = useState(defaultEditorData);
  const isMobile = useCoarsePointer();
  const timelineState = useRef<TimelineState | null>(null);
  const playerPanel = useRef<HTMLDivElement | null>(null);
  const timelineWrapRef = useRef<HTMLDivElement | null>(null);
  const autoScrollWhenPlay = useRef<boolean>(true);
  const [armedFootageId, setArmedFootageId] = useState<string | null>(null);
  const armedFootageRef = useRef<(typeof FOOTAGE_BIN)[number] | null>(null);
  const timelinePointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const cursorDraggingRef = useRef<{ pointerId: number } | null>(null);

  // Preload media referenced by timeline actions to reduce buffering/stalls during playback.
  // This is intentionally fire-and-forget; cache dedupes across edits.
  useEffect(() => {
    mediaCache.warmFromEditorData(data);
  }, [data]);

  const uidCounterRef = useRef(0);
  const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `uid-${++uidCounterRef.current}`);

  const rangesOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && aEnd > bStart;

  const wouldOverlapInRow = (row: CusTomTimelineRow, movingActionId: string, nextStart: number, nextEnd: number) => {
    const actions = Array.isArray(row?.actions) ? row.actions : [];
    for (const other of actions) {
      if (!other || other.id === movingActionId) continue;
      if (rangesOverlap(nextStart, nextEnd, Number(other.start), Number(other.end))) return true;
    }
    return false;
  };

  const insertActionAtTime = (item: { kind: 'video' | 'audio'; src: string; previewSrc?: string; name: string; defaultDuration?: number }, at: number) => {
    const duration = item.defaultDuration ?? 10;
    let start = Math.max(0, at);
    let end = start + duration;

    setData((prev) => {
      const next = structuredClone(prev) as CusTomTimelineRow[];
      // Ensure we have at least 2 rows: [videoRow, audioRow]
      while (next.length < 2) next.push({ id: `${next.length}`, actions: [] } as unknown as CusTomTimelineRow);
      const rowIndex = item.kind === 'video' ? 0 : 1;

      // Do not allow overlaps in the row: bump forward until we find a free slot.
      const existing = Array.isArray(next[rowIndex].actions) ? next[rowIndex].actions : [];
      const sorted = [...existing].sort((a, b) => Number(a.start) - Number(b.start));
      for (const other of sorted) {
        const otherStart = Number(other.start);
        const otherEnd = Number(other.end);
        if (!Number.isFinite(otherStart) || !Number.isFinite(otherEnd)) continue;
        if (!rangesOverlap(start, end, otherStart, otherEnd)) continue;
        start = otherEnd;
        end = start + duration;
      }

      next[rowIndex].actions = [
        ...(next[rowIndex].actions ?? []),
        {
          id: `${item.kind}-${uid()}`,
          start,
          end,
          effectId: item.kind === 'video' ? 'effect1' : 'effect0',
          data: { src: item.src, previewSrc: item.previewSrc, name: item.name },
        } as CustomTimelineAction,
      ];
      return next;
    });
  };

  const getTimelineScrollLeft = () => {
    const root = timelineWrapRef.current;
    if (!root) return 0;
    const grid = root.querySelector('.timeline-editor-edit-area .ReactVirtualized__Grid') as HTMLElement | null;
    return (grid as any)?.scrollLeft ?? 0;
  };

  const dropTimeFromEvent = (e: React.DragEvent) => {
    const root = timelineWrapRef.current;
    if (!root) return 0;
    const editArea = root.querySelector('.timeline-editor-edit-area') as HTMLElement | null;
    const rect = (editArea ?? root).getBoundingClientRect();
    const position = e.clientX - rect.x;
    const left = position + getTimelineScrollLeft();
    const time = ((left - startLeft) * scale) / scaleWidth;
    return Math.max(0, time);
  };

  const handleDropOnTimeline = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/x-footage-item');
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: 'video' | 'audio'; src: string; name: string; defaultDuration?: number };
      const at = dropTimeFromEvent(e);
      insertActionAtTime(item, at);
    } catch {
      // ignore
    }
  };

  const timeFromClientX = (clientX: number) => {
    const root = timelineWrapRef.current;
    if (!root) return 0;
    const editArea = root.querySelector('.timeline-editor-edit-area') as HTMLElement | null;
    const rect = (editArea ?? root).getBoundingClientRect();
    const position = clientX - rect.x;
    const left = position + getTimelineScrollLeft();
    const time = ((left - startLeft) * scale) / scaleWidth;
    return Math.max(0, time);
  };

  const setSelection = (rowId: string, actionId: string) => {
    setData((prev) => {
      const next = structuredClone(prev) as CusTomTimelineRow[];
      for (const row of next) {
        (row as any).selected = row.id === rowId;
        const actions = (row as any).actions;
        if (!Array.isArray(actions)) continue;
        for (const action of actions) {
          (action as any).selected = row.id === rowId && (action as any).id === actionId;
        }
      }
      return next;
    });
  };

  const clearArmedFootage = () => {
    armedFootageRef.current = null;
    setArmedFootageId(null);
  };

  const handleTimelinePointerDown = (e: React.PointerEvent) => {
    if (!isMobile) return;
    // Only treat touch/pen as mobile gesture; mouse keeps desktop behavior.
    if (e.pointerType === 'mouse') return;

    // Cursor drag on mobile: the library's cursor drag is mouse-event oriented, so we shim it.
    const target = e.target as HTMLElement | null;
    const isCursorHit = Boolean(target?.closest?.('.timeline-editor-cursor-area, .timeline-editor-cursor'));
    if (isCursorHit) {
      cursorDraggingRef.current = { pointerId: e.pointerId };
      timelinePointerDownRef.current = null;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
      return;
    }

    timelinePointerDownRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleTimelinePointerMove = (e: React.PointerEvent) => {
    if (!isMobile) return;
    if (e.pointerType === 'mouse') return;
    if (!cursorDraggingRef.current) return;
    if (cursorDraggingRef.current.pointerId !== e.pointerId) return;

    const t = timeFromClientX(e.clientX);
    if (timelineState.current) timelineState.current.setTime(t);
    e.preventDefault();
  };

  const handleTimelinePointerUp = (e: React.PointerEvent) => {
    if (!isMobile) return;
    if (e.pointerType === 'mouse') return;

    // Finish cursor drag and don't treat it as a tap.
    if (cursorDraggingRef.current && cursorDraggingRef.current.pointerId === e.pointerId) {
      cursorDraggingRef.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
      return;
    }

    const start = timelinePointerDownRef.current;
    timelinePointerDownRef.current = null;
    const dx = start ? Math.abs(e.clientX - start.x) : 0;
    const dy = start ? Math.abs(e.clientY - start.y) : 0;

    // If the finger moved, it was likely a scroll/drag gesture.
    if (dx > 10 || dy > 10) return;

    const target = e.target as HTMLElement | null;
    const actionEl = target?.closest?.('[data-action-id]') as HTMLElement | null;
    const rowId = actionEl?.getAttribute('data-row-id');
    const actionId = actionEl?.getAttribute('data-action-id');

    // Tap on an action: select it and seek to its start time.
    if (rowId && actionId) {
      setSelection(rowId, actionId);

      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        if ((row as any)?.id !== rowId) continue;
        const actions = (row as any)?.actions;
        if (!Array.isArray(actions)) break;
        const found = actions.find((a: any) => a?.id === actionId);
        const startTime = Number(found?.start);
        if (timelineState.current && Number.isFinite(startTime)) {
          timelineState.current.setTime(startTime);
        }
        break;
      }
      return;
    }

    const t = timeFromClientX(e.clientX);

    // If a footage item is armed, releasing on the timeline inserts it here.
    if (armedFootageRef.current) {
      insertActionAtTime(armedFootageRef.current, t);
      clearArmedFootage();
      return;
    }

    // Otherwise, releasing on empty space just sets the playhead time.
    if (timelineState.current) timelineState.current.setTime(t);
  };

  return (
    <div className="timeline-editor-engine">
      <div className="player-config">
        <div className="footage-bin">
          {FOOTAGE_BIN.map((item) => (
            <div
              key={item.id}
              className={`footage-card${armedFootageId === item.id ? ' is-armed' : ''}`}
              draggable={!isMobile}
              onDragStart={(e) => {
                if (isMobile) return;
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('application/x-footage-item', JSON.stringify(item));
              }}
              onPointerDown={(e) => {
                if (!isMobile) return;
                if (e.pointerType === 'mouse') return;
                // Arm item on press (mobile replacement for drag start).
                armedFootageRef.current = item;
                setArmedFootageId(item.id);
              }}
              onPointerUp={(e) => {
                if (!isMobile) return;
                if (e.pointerType === 'mouse') return;
                // Keep it armed until the user releases on the timeline.
                e.preventDefault();
              }}
            >
              <div className="footage-name">{item.name}</div>
              {item.kind === 'video' ? (
                <video className="footage-preview" src={item.src} muted preload="metadata" />
              ) : (
                <audio className="footage-audio" src={item.src} controls preload="metadata" />
              )}
              <div className="footage-kind">{isMobile ? 'Press to pick up, release on timeline' : 'Drag into timeline'}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="player-panel" ref={playerPanel}>
        <video
          className="player-video"
          preload="auto"
          playsInline
          controls={false}
          disablePictureInPicture
          disableRemotePlayback
          controlsList="nodownload noplaybackrate noremoteplayback"
          tabIndex={-1}
          onContextMenu={(e) => e.preventDefault()}
          ref={(el) => videoControl.attach(el)}
        />
      </div>
      <TimelinePlayer timelineState={timelineState} autoScrollWhenPlay={autoScrollWhenPlay} editorData={data} />
      <div
        ref={timelineWrapRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDropOnTimeline}
        onPointerDown={handleTimelinePointerDown}
        onPointerMove={handleTimelinePointerMove}
        onPointerUp={handleTimelinePointerUp}
      >
        <Timeline
          scale={scale}
          scaleWidth={scaleWidth}
          startLeft={startLeft}
          rowHeight={isMobile ? 48 : undefined}
          autoScroll={true}
          ref={timelineState}
          editorData={data}
          effects={mockEffect}
          onActionMoving={({ action, row, start, end }) => {
            const nextStart = Number(start);
            const nextEnd = Number(end);
            if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return false;
            if (nextEnd <= nextStart) return false;

            const typedRow = row as CusTomTimelineRow;
            if (wouldOverlapInRow(typedRow, String(action.id), nextStart, nextEnd)) return false;
          }}
          onActionResizing={({ action, row, start, end }) => {
            const nextStart = Number(start);
            const nextEnd = Number(end);
            if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return false;
            if (nextEnd <= nextStart) return false;

            const typedRow = row as CusTomTimelineRow;
            if (wouldOverlapInRow(typedRow, String(action.id), nextStart, nextEnd)) return false;
          }}
          onChange={(data) => {
            setData(data as CusTomTimelineRow[]);
          }}
          getActionRender={(action, row) => {
            if (action.effectId === 'effect0') {
              return <CustomRender0 action={action as CustomTimelineAction} row={row as CusTomTimelineRow} />;
            } else if (action.effectId === 'effect1') {
              return <CustomRender1 action={action as CustomTimelineAction} row={row as CusTomTimelineRow} />;
            }
          }}
        />
      </div>
    </div>
  );
};
export default TimelineEditor;