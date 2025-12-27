import { Timeline } from '@xzdarcy/react-timeline-editor';
import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CustomRender0, CustomRender1 } from './custom';
import './index.less';
import { mockData, mockEffect, scale, scaleWidth, startLeft } from './mock';
import type { CustomTimelineAction, CusTomTimelineRow } from './mock';
import { FOOTAGE_BIN, type FootageItem } from './footageBin';
import TimelinePlayer from './player';
import videoControl from './videoControl';
import mediaCache from './mediaCache';
import { useCoarsePointer } from './useCoarsePointer';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

const defaultEditorData = structuredClone(mockData);

const FootageCard = ({ item, hint, isDragging }: { item: FootageItem; hint: string; isDragging: boolean }) => {
  return (
    <div className={`footage-card${isDragging ? ' is-dragging' : ''}`}>
      <div className="footage-name">{item.name}</div>
      {item.kind === 'video' ? (
        <video
          className="footage-preview"
          src={item.src}
          muted
          preload="metadata"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          playsInline
        />
      ) : (
        <audio
          className="footage-audio"
          src={item.src}
          controls
          preload="metadata"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
        />
      )}
      <div className="footage-kind">{hint}</div>
    </div>
  );
};

const DraggableFootageCard = ({ item, hint }: { item: FootageItem; hint: string }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `footage-${item.id}`,
    data: { item },
  });

  const style: React.CSSProperties | undefined = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <FootageCard item={item} hint={hint} isDragging={isDragging} />
    </div>
  );
};

const TimelineEditor = () => {
  const [data, setData] = useState<CusTomTimelineRow[]>(defaultEditorData as CusTomTimelineRow[]);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const isMobile = useCoarsePointer();
  const timelineState = useRef<TimelineState | null>(null);
  const playerPanel = useRef<HTMLDivElement | null>(null);
  const timelineWrapRef = useRef<HTMLDivElement | null>(null);
  const autoScrollWhenPlay = useRef<boolean>(true);
  const [activeFootage, setActiveFootage] = useState<FootageItem | null>(null);
  const [activeFootageSize, setActiveFootageSize] = useState<{ width: number; height: number } | null>(null);
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
    return grid?.scrollLeft ?? 0;
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

  /**
   * Strip selection flags from editor data so our canonical state stays "clean".
   * This prevents selection taps from generating noisy undo/redo steps later.
   */
  const cleanEditorData = (rows: CusTomTimelineRow[]): CusTomTimelineRow[] =>
    rows.map((row) => ({
      ...row,
      selected: undefined,
      actions: (row.actions ?? []).map((action) => ({ ...action, selected: undefined })),
    }));

  /**
   * Add selection flags only for rendering. The timeline library uses `action.selected`
   * to attach the `action-selected` CSS class.
   */
  const editorDataForRender = useMemo(() => {
    if (!selectedActionId) return data;

    return data.map((row) => {
      const hasSelected = (row.actions ?? []).some((action) => String(action.id) === selectedActionId);
      return {
        ...row,
        selected: hasSelected,
        actions: (row.actions ?? []).map((action) => ({
          ...action,
          selected: String(action.id) === selectedActionId,
        })),
      };
    });
  }, [data, selectedActionId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // On touch, require a short press-hold before starting drag, so scroll is still possible.
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } })
  );

  const { setNodeRef: setTimelineDropRef, isOver: isTimelineOver } = useDroppable({ id: 'timeline-drop' });

  const handleDragStart = (event: DragStartEvent) => {
    const item = (event.active.data.current as any)?.item as FootageItem | undefined;
    setActiveFootage(item ?? null);

    const initial = event.active.rect.current.initial;
    if (initial) {
      setActiveFootageSize({ width: initial.width, height: initial.height });
    } else {
      setActiveFootageSize(null);
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    if (activeFootageSize) return;
    const initial = event.active.rect.current.initial;
    if (initial) {
      setActiveFootageSize({ width: initial.width, height: initial.height });
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const item = (event.active.data.current as any)?.item as FootageItem | undefined;
    const overTimeline = String(event.over?.id ?? '') === 'timeline-drop';
    const cursorTime = timelineState.current?.getTime ? timelineState.current.getTime() : 0;
    const shouldInsertAtCursor = Boolean(item) && (overTimeline || event.over == null);

    if (item && shouldInsertAtCursor) {
      insertActionAtTime(item, Math.max(0, cursorTime));
    }

    setActiveFootage(null);
    setActiveFootageSize(null);
  };

  const handleDragCancel = () => {
    setActiveFootage(null);
    setActiveFootageSize(null);
  };

  const handleTimelinePointerDown = (e: React.PointerEvent) => {
    if (!isMobile) return;
    // Only treat touch/pen as mobile gesture; mouse keeps desktop behavior.
    if (e.pointerType === 'mouse') return;
    // If a dnd-kit drag is active, let it own the gesture.
    if (activeFootage) return;

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
    if (activeFootage) return;
    if (!cursorDraggingRef.current) return;
    if (cursorDraggingRef.current.pointerId !== e.pointerId) return;

    const t = timeFromClientX(e.clientX);
    if (timelineState.current) timelineState.current.setTime(t);
    e.preventDefault();
  };

  const handleTimelinePointerUp = (e: React.PointerEvent) => {
    if (!isMobile) return;
    if (e.pointerType === 'mouse') return;
    if (activeFootage) return;

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
      setSelectedActionId(actionId);
      return;
    }

    const t = timeFromClientX(e.clientX);

    // Otherwise, releasing on empty space just sets the playhead time.
    if (timelineState.current) timelineState.current.setTime(t);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={rectIntersection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="timeline-editor-engine">
        <div className="player-config">
          <div className="footage-bin">
            {FOOTAGE_BIN.map((item) => (
              <DraggableFootageCard
                key={item.id}
                item={item}
                hint={isMobile ? 'Press-hold, then drag into timeline' : 'Drag into timeline'}
              />
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
          className={`timeline-drop${isTimelineOver ? ' is-over' : ''}`}
          ref={(node) => {
            timelineWrapRef.current = node;
            setTimelineDropRef(node);
          }}
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
            editorData={editorDataForRender}
            effects={mockEffect}
            onClickActionOnly={(_e, { action }) => {
              const clickedAction = action as unknown as CustomTimelineAction;
              if (!clickedAction?.id) return;
              setSelectedActionId(String(clickedAction.id));
            }}
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
              setData(cleanEditorData(data as CusTomTimelineRow[]));
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

        <DragOverlay>
          {activeFootage ? (
            <div
              className="footage-overlay"
              style={
                activeFootageSize
                  ? {
                      width: activeFootageSize.width,
                      height: activeFootageSize.height,
                    }
                  : undefined
              }
            >
              <FootageCard item={activeFootage} hint="Drop on timeline" isDragging={true} />
            </div>
          ) : null}
        </DragOverlay>
      </div>
    </DndContext>
  );
};
export default TimelineEditor;