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

const MAX_HISTORY = 5;

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
  const [past, setPast] = useState<CusTomTimelineRow[][]>([]);
  const [future, setFuture] = useState<CusTomTimelineRow[][]>([]);
  const dataRef = useRef<CusTomTimelineRow[]>(data);
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

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const uidCounterRef = useRef(0);
  const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `uid-${++uidCounterRef.current}`);

  const pendingHistoryBeforeRef = useRef<CusTomTimelineRow[] | null>(null);
  const pendingHistorySignatureRef = useRef<string | null>(null);

  /**
   * Compute a lightweight signature of the timeline data for change detection.
   * This keeps undo/redo history from recording no-op moves/resizes.
   */
  const getTimelineSignature = (rows: CusTomTimelineRow[]) => {
    return rows
      .map((row) => {
        const actionsSig = (row.actions ?? [])
          .map((action) => `${String(action.id)}@${Number(action.start)}-${Number(action.end)}`)
          .join('|');
        return `${String(row.id)}:${actionsSig}`;
      })
      .join('||');
  };

  /**
   * Push a snapshot into the undo stack (past), clear redo stack (future), and cap to MAX_HISTORY.
   */
  const pushHistory = (before: CusTomTimelineRow[]) => {
    const snapshot = structuredClone(before) as CusTomTimelineRow[];
    setPast((prev) => {
      const next = [...prev, snapshot];
      if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
      return next;
    });
    setFuture([]);
  };

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

    const state = timelineState.current;
    if (state?.isPlaying) state.pause();

    setData((prev) => {
      pushHistory(prev);
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

  /**
   * Delete the currently selected action from the timeline.
   *
   * Notes:
   * - Operates on the canonical (clean) editor data.
   * - Clears selection after deletion.
   * - If playback is active, pauses first (to avoid transient audio/video glitches).
   */
  const deleteSelectedClip = () => {
    if (!selectedActionId) return;

    const state = timelineState.current;
    if (state?.isPlaying) state.pause();

    setData((prev) => {
      pushHistory(prev);
      const next = prev.map((row) => ({
        ...row,
        actions: (row.actions ?? []).filter((action) => String(action.id) !== selectedActionId),
      }));
      return next;
    });

    setSelectedActionId(null);
  };

  /**
   * Split the selected action at the current cursor/playhead time.
   *
   * Behavior:
   * - Only splits when the cursor time is strictly inside the clip (start < t < end).
   * - Pauses playback before applying changes.
   * - Records a single undo history entry (snapshot before split).
   * - Keeps the left segment selected by retaining the original action id.
   */
  const splitSelectedClipAtCursor = () => {
    if (!selectedActionId) return;

    const state = timelineState.current;
    const cursorTimeRaw = state?.getTime ? state.getTime() : null;
    if (cursorTimeRaw == null) return;

    const cursorTime = Number(cursorTimeRaw);
    if (!Number.isFinite(cursorTime)) return;
    if (state?.isPlaying) state.pause();

    // Clear any in-flight drag/resize capture so it can't be committed later.
    pendingHistoryBeforeRef.current = null;
    pendingHistorySignatureRef.current = null;

    setData((prev) => {
      // Find the selected action and validate split is possible.
      let foundRowIndex = -1;
      let foundActionIndex = -1;
      let foundAction: CustomTimelineAction | null = null;

      for (let rowIndex = 0; rowIndex < prev.length; rowIndex++) {
        const row = prev[rowIndex];
        const actions = Array.isArray(row?.actions) ? row.actions : [];
        for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
          const action = actions[actionIndex] as unknown as CustomTimelineAction;
          if (String(action?.id) !== selectedActionId) continue;
          foundRowIndex = rowIndex;
          foundActionIndex = actionIndex;
          foundAction = action;
          break;
        }
        if (foundAction) break;
      }

      if (!foundAction) return prev;

      const start = Number(foundAction.start);
      const end = Number(foundAction.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return prev;
      if (!(start < cursorTime && cursorTime < end)) return prev;

      pushHistory(prev);

      const rightActionId = `${String(foundAction.id)}-r-${uid()}`;
      const currentOffsetRaw = Number((foundAction as any)?.data?.offset ?? 0);
      const currentOffset = Number.isFinite(currentOffsetRaw) ? currentOffsetRaw : 0;
      const splitDelta = cursorTime - start;
      const rightOffset = currentOffset + (Number.isFinite(splitDelta) ? splitDelta : 0);

      const left: CustomTimelineAction = {
        ...foundAction,
        start,
        end: cursorTime,
        id: foundAction.id,
        data: { ...(foundAction as any).data, offset: currentOffset },
      };
      const right: CustomTimelineAction = {
        ...foundAction,
        start: cursorTime,
        end,
        id: rightActionId,
        data: { ...(foundAction as any).data, offset: rightOffset },
      };

      const next = structuredClone(prev) as CusTomTimelineRow[];
      const nextRow = next[foundRowIndex];
      const nextActions = Array.isArray(nextRow.actions) ? [...nextRow.actions] : [];
      nextActions.splice(foundActionIndex, 1, left, right);
      nextActions.sort((a, b) => Number((a as any).start) - Number((b as any).start));
      nextRow.actions = nextActions as any;

      return next;
    });
  };

  /**
   * Undo the last timeline edit (up to MAX_HISTORY).
   */
  const undo = () => {
    const state = timelineState.current;
    const currentTime = state?.getTime ? state.getTime() : null;
    if (state?.isPlaying) state.pause();

    // Clear any in-flight drag/resize capture.
    pendingHistoryBeforeRef.current = null;
    pendingHistorySignatureRef.current = null;
    setSelectedActionId(null);

    setPast((prevPast) => {
      if (prevPast.length === 0) return prevPast;

      const previous = prevPast[prevPast.length - 1];
      const currentSnapshot = structuredClone(dataRef.current) as CusTomTimelineRow[];

      setFuture((prevFuture) => [...prevFuture, currentSnapshot]);
      setData(structuredClone(previous) as CusTomTimelineRow[]);

      return prevPast.slice(0, -1);
    });

    if (currentTime != null) {
      requestAnimationFrame(() => {
        const s = timelineState.current;
        if (s?.setTime) s.setTime(currentTime);
      });
    }
  };

  /**
   * Redo the last undone timeline edit.
   */
  const redo = () => {
    const state = timelineState.current;
    const currentTime = state?.getTime ? state.getTime() : null;
    if (state?.isPlaying) state.pause();

    pendingHistoryBeforeRef.current = null;
    pendingHistorySignatureRef.current = null;
    setSelectedActionId(null);

    setFuture((prevFuture) => {
      if (prevFuture.length === 0) return prevFuture;

      const next = prevFuture[prevFuture.length - 1];
      const currentSnapshot = structuredClone(dataRef.current) as CusTomTimelineRow[];

      setPast((prevPast) => {
        const out = [...prevPast, currentSnapshot];
        if (out.length > MAX_HISTORY) out.splice(0, out.length - MAX_HISTORY);
        return out;
      });
      setData(structuredClone(next) as CusTomTimelineRow[]);

      return prevFuture.slice(0, -1);
    });

    if (currentTime != null) {
      requestAnimationFrame(() => {
        const s = timelineState.current;
        if (s?.setTime) s.setTime(currentTime);
      });
    }
  };

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

    // Otherwise, releasing on empty space deselects and sets the playhead time.
    setSelectedActionId(null);
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
        <TimelinePlayer
          timelineState={timelineState}
          autoScrollWhenPlay={autoScrollWhenPlay}
          editorData={data}
          selectedActionId={selectedActionId}
          onDeleteSelectedClip={deleteSelectedClip}
          onSplitSelectedClip={splitSelectedClipAtCursor}
          canUndo={past.length > 0}
          canRedo={future.length > 0}
          onUndo={undo}
          onRedo={redo}
        />
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
            onClickTimeArea={(_time, _e) => {
              setSelectedActionId(null);
              return undefined;
            }}
            onClickRow={(e) => {
              const target = e.target as HTMLElement | null;
              // If the click originated from an action, don't let the row click clear selection.
              if (target?.closest?.('.timeline-editor-action')) return;
              setSelectedActionId(null);
            }}
            onClickActionOnly={(_e, { action }) => {
              const clickedAction = action as unknown as CustomTimelineAction;
              if (!clickedAction?.id) return;
              setSelectedActionId(String(clickedAction.id));
            }}
            onActionMoveStart={() => {
              if (pendingHistoryBeforeRef.current) return;
              pendingHistoryBeforeRef.current = structuredClone(data) as CusTomTimelineRow[];
              pendingHistorySignatureRef.current = getTimelineSignature(data);
            }}
            onActionResizeStart={() => {
              if (pendingHistoryBeforeRef.current) return;
              pendingHistoryBeforeRef.current = structuredClone(data) as CusTomTimelineRow[];
              pendingHistorySignatureRef.current = getTimelineSignature(data);
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
              const nextClean = cleanEditorData(data as CusTomTimelineRow[]);
              setData(nextClean);

              // If this onChange is the result of a drag/resize gesture, record a single history entry.
              const pendingBefore = pendingHistoryBeforeRef.current;
              const pendingSig = pendingHistorySignatureRef.current;
              if (pendingBefore && pendingSig) {
                const nextSig = getTimelineSignature(nextClean);
                if (nextSig !== pendingSig) pushHistory(pendingBefore);
                pendingHistoryBeforeRef.current = null;
                pendingHistorySignatureRef.current = null;
              }
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