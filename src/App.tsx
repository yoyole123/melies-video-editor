import { Timeline } from '@xzdarcy/react-timeline-editor';
import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CustomRender0, CustomRender1, CustomRender2 } from './custom';
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
  const pendingGestureActionIdRef = useRef<string | null>(null);

  // Cursor magnet: snap when close, but release easily if the user keeps dragging.
  const CURSOR_SNAP_THRESHOLD_SEC = 0.9;
  const CURSOR_SNAP_RELEASE_SEC = 1.05;
  const snapStateRef = useRef<{
    actionId: string | null;
    edge: 'start' | 'end' | null;
  }>({ actionId: null, edge: null });

  const gestureRef = useRef<{
    actionId: string | null;
    mode: 'move' | 'resize' | null;
    dir: 'left' | 'right' | null;
    // Used to convert pointer X deltas into time deltas.
    basePointerTime: number | null;
    lastPointerTime: number | null;
    // Baseline clip range at the moment we "take over".
    initialStart: number;
    initialEnd: number;
    // Once snapping engages, we fully drive the clip from state.
    takeover: boolean;
  }>({
    actionId: null,
    mode: null,
    dir: null,
    basePointerTime: null,
    lastPointerTime: null,
    initialStart: 0,
    initialEnd: 0,
    takeover: false,
  });

  const pointerListenersAttachedRef = useRef(false);

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

  const findActionById = (rows: CusTomTimelineRow[], actionId: string) => {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const actions = Array.isArray(row?.actions) ? row.actions : [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
        const action = actions[actionIndex] as unknown as CustomTimelineAction;
        if (String(action?.id) !== actionId) continue;
        return { rowIndex, actionIndex, action };
      }
    }
    return null;
  };

  const findLinkedPartner = (rows: CusTomTimelineRow[], actionId: string) => {
    const found = findActionById(rows, actionId);
    const linkId = found?.action?.data?.linkId;
    if (!found || !linkId) return null;

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const actions = Array.isArray(row?.actions) ? row.actions : [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
        const action = actions[actionIndex] as unknown as CustomTimelineAction;
        if (!action?.data?.linkId) continue;
        if (String(action.data.linkId) !== String(linkId)) continue;
        if (String(action.id) === String(actionId)) continue;
        return { rowIndex, actionIndex, action };
      }
    }
    return null;
  };

  const applyLinkedStartEnd = (rows: CusTomTimelineRow[], sourceActionId: string) => {
    const source = findActionById(rows, sourceActionId);
    if (!source) return rows;
    const partner = findLinkedPartner(rows, sourceActionId);
    if (!partner) return rows;

    const nextStart = Number(source.action.start);
    const nextEnd = Number(source.action.end);
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart) return rows;
    if (Number(partner.action.start) === nextStart && Number(partner.action.end) === nextEnd) return rows;

    const next = structuredClone(rows) as CusTomTimelineRow[];
    const partnerRow = next[partner.rowIndex];
    const actions = Array.isArray(partnerRow.actions) ? [...partnerRow.actions] : [];
    const updated: CustomTimelineAction = { ...(actions[partner.actionIndex] as any), start: nextStart, end: nextEnd };
    actions.splice(partner.actionIndex, 1, updated as any);
    partnerRow.actions = actions as any;
    return next;
  };

  const setStartEndForActionAndLinked = (rows: CusTomTimelineRow[], sourceActionId: string, nextStart: number, nextEnd: number) => {
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart) return rows;

    const source = findActionById(rows, sourceActionId);
    if (!source) return rows;

    const partner = findLinkedPartner(rows, sourceActionId);

    // Fast path: if not linked, don't force state updates (let the library handle visuals).
    if (!partner) return rows;

    const next = structuredClone(rows) as CusTomTimelineRow[];

    const sourceRow = next[source.rowIndex];
    const sourceActions = Array.isArray(sourceRow.actions) ? [...sourceRow.actions] : [];
    const updatedSource: CustomTimelineAction = { ...(sourceActions[source.actionIndex] as any), start: nextStart, end: nextEnd };
    sourceActions.splice(source.actionIndex, 1, updatedSource as any);
    sourceRow.actions = sourceActions as any;

    const partnerRow = next[partner.rowIndex];
    const partnerActions = Array.isArray(partnerRow.actions) ? [...partnerRow.actions] : [];
    const updatedPartner: CustomTimelineAction = { ...(partnerActions[partner.actionIndex] as any), start: nextStart, end: nextEnd };
    partnerActions.splice(partner.actionIndex, 1, updatedPartner as any);
    partnerRow.actions = partnerActions as any;

    return next;
  };

  const setStartEndForActionOnly = (rows: CusTomTimelineRow[], sourceActionId: string, nextStart: number, nextEnd: number) => {
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart) return rows;
    const source = findActionById(rows, sourceActionId);
    if (!source) return rows;
    const existingStart = Number(source.action.start);
    const existingEnd = Number(source.action.end);
    if (existingStart === nextStart && existingEnd === nextEnd) return rows;

    const next = structuredClone(rows) as CusTomTimelineRow[];
    const sourceRow = next[source.rowIndex];
    const sourceActions = Array.isArray(sourceRow.actions) ? [...sourceRow.actions] : [];
    const updatedSource: CustomTimelineAction = { ...(sourceActions[source.actionIndex] as any), start: nextStart, end: nextEnd };
    sourceActions.splice(source.actionIndex, 1, updatedSource as any);
    sourceRow.actions = sourceActions as any;
    return next;
  };

  const getCursorTime = () => {
    const t = timelineState.current?.getTime ? Number(timelineState.current.getTime()) : 0;
    return Number.isFinite(t) ? Math.max(0, t) : 0;
  };

  const maybeSnapToCursorForMove = (actionId: string, nextStart: number, nextEnd: number) => {
    const cursorTime = getCursorTime();
    const duration = nextEnd - nextStart;
    if (!Number.isFinite(duration) || duration <= 0) {
      return { start: nextStart, end: nextEnd, snapped: false, edge: null as any };
    }

    const distStart = Math.abs(nextStart - cursorTime);
    const distEnd = Math.abs(nextEnd - cursorTime);
    const closerEdge: 'start' | 'end' = distStart <= distEnd ? 'start' : 'end';
    const minDist = Math.min(distStart, distEnd);

    const snapState = snapStateRef.current;
    const isSameAction = snapState.actionId === actionId;
    const isSnapped = isSameAction && snapState.edge != null;

    if (!isSnapped) {
      if (minDist > CURSOR_SNAP_THRESHOLD_SEC) {
        return { start: nextStart, end: nextEnd, snapped: false, edge: null as any };
      }
      snapStateRef.current = { actionId, edge: closerEdge };
    } else {
      const edge = snapState.edge;
      const dist = edge === 'start' ? distStart : distEnd;
      if (dist > CURSOR_SNAP_RELEASE_SEC) {
        snapStateRef.current = { actionId, edge: null };
        return { start: nextStart, end: nextEnd, snapped: false, edge: null as any };
      }
    }

    const edge = snapStateRef.current.edge as 'start' | 'end';
    if (edge === 'start') {
      const start = cursorTime;
      const end = start + duration;
      return { start: Math.max(0, start), end: Math.max(Math.max(0, start), end), snapped: true, edge };
    }

    const end = cursorTime;
    const start = end - duration;
    return { start: Math.max(0, start), end: Math.max(0, end), snapped: true, edge };
  };

  const maybeSnapToCursorForResize = (actionId: string, nextStart: number, nextEnd: number, dir: 'left' | 'right') => {
    const cursorTime = getCursorTime();
    const snapEdge: 'start' | 'end' = dir === 'left' ? 'start' : 'end';
    const dist = snapEdge === 'start' ? Math.abs(nextStart - cursorTime) : Math.abs(nextEnd - cursorTime);

    const snapState = snapStateRef.current;
    const isSameAction = snapState.actionId === actionId;
    const isSnapped = isSameAction && snapState.edge === snapEdge;

    if (!isSnapped) {
      if (dist > CURSOR_SNAP_THRESHOLD_SEC) {
        return { start: nextStart, end: nextEnd, snapped: false };
      }
      snapStateRef.current = { actionId, edge: snapEdge };
    } else {
      if (dist > CURSOR_SNAP_RELEASE_SEC) {
        snapStateRef.current = { actionId, edge: null };
        return { start: nextStart, end: nextEnd, snapped: false };
      }
    }

    if (snapEdge === 'start') {
      const start = Math.max(0, cursorTime);
      const end = Math.max(start + 0.01, nextEnd);
      return { start, end, snapped: true };
    }

    const end = Math.max(0, cursorTime);
    const start = Math.min(nextStart, end - 0.01);
    return { start: Math.max(0, start), end, snapped: true };
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

      // Ensure we have at least 3 rows:
      // 0: video
      // 1: embedded video audio
      // 2: external audio
      while (next.length < 3) next.push({ id: `${next.length}`, actions: [] } as unknown as CusTomTimelineRow);

      const bumpStartToAvoidOverlaps = (rowIndexes: number[]) => {
        const intervals: Array<{ start: number; end: number }> = [];
        for (const idx of rowIndexes) {
          const actions = Array.isArray(next[idx]?.actions) ? next[idx].actions : [];
          for (const a of actions) {
            const s = Number((a as any)?.start);
            const e = Number((a as any)?.end);
            if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
            intervals.push({ start: s, end: e });
          }
        }
        intervals.sort((a, b) => a.start - b.start);

        // Bump forward until [start,end] doesn't overlap any interval.
        for (const other of intervals) {
          if (!rangesOverlap(start, end, other.start, other.end)) continue;
          start = other.end;
          end = start + duration;
        }
      };

      if (item.kind === 'video') {
        // Find a slot that is free in BOTH video row and video-audio row.
        bumpStartToAvoidOverlaps([0, 1]);

        const linkId = `link-${uid()}`;
        const clipId = `video-${uid()}`;
        const audioId = `video-audio-${uid()}`;

        next[0].actions = [
          ...(next[0].actions ?? []),
          {
            id: clipId,
            start,
            end,
            effectId: 'effect1',
            data: { src: item.src, previewSrc: item.previewSrc, name: item.name, linkId },
          } as CustomTimelineAction,
        ];

        next[1].actions = [
          ...(next[1].actions ?? []),
          {
            id: audioId,
            start,
            end,
            effectId: 'effect2',
            data: { src: item.src, name: item.name, linkId },
          } as CustomTimelineAction,
        ];
      } else {
        // External audio: only needs a free slot in the external-audio row.
        bumpStartToAvoidOverlaps([2]);
        next[2].actions = [
          ...(next[2].actions ?? []),
          {
            id: `audio-${uid()}`,
            start,
            end,
            effectId: 'effect0',
            data: { src: item.src, name: item.name },
          } as CustomTimelineAction,
        ];
      }

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

  const attachGesturePointerTracking = () => {
    if (pointerListenersAttachedRef.current) return;
    pointerListenersAttachedRef.current = true;

    const onPointerMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g.actionId || !g.mode) return;
      // Only track primary pointer (helps avoid odd multi-touch behavior).
      if (e.isPrimary === false) return;

      const t = timeFromClientX(e.clientX);
      if (g.basePointerTime == null) {
        g.basePointerTime = t;
      }
      g.lastPointerTime = t;
    };

    const onPointerUpOrCancel = () => {
      // If the lib misses an end callback, ensure we don't stay stuck in takeover mode.
      gestureRef.current = {
        actionId: null,
        mode: null,
        dir: null,
        basePointerTime: null,
        lastPointerTime: null,
        initialStart: 0,
        initialEnd: 0,
        takeover: false,
      };
      snapStateRef.current = { actionId: null, edge: null };
    };

    window.addEventListener('pointermove', onPointerMove, { capture: true });
    window.addEventListener('pointerup', onPointerUpOrCancel, { capture: true });
    window.addEventListener('pointercancel', onPointerUpOrCancel, { capture: true });

    // Stash removers on the ref object (cheapest place without extra state).
    (gestureRef.current as any)._removePointerListeners = () => {
      window.removeEventListener('pointermove', onPointerMove, { capture: true } as any);
      window.removeEventListener('pointerup', onPointerUpOrCancel, { capture: true } as any);
      window.removeEventListener('pointercancel', onPointerUpOrCancel, { capture: true } as any);
      pointerListenersAttachedRef.current = false;
    };
  };

  const detachGesturePointerTracking = () => {
    const remove = (gestureRef.current as any)?._removePointerListeners as undefined | (() => void);
    remove?.();
    delete (gestureRef.current as any)._removePointerListeners;
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

      // If this is a linked clip (video <-> embedded audio), delete the whole linked pair.
      let linkId: string | null = null;
      for (const row of prev) {
        const actions = Array.isArray(row?.actions) ? row.actions : [];
        for (const action of actions) {
          if (String((action as any)?.id) !== selectedActionId) continue;
          const candidate = (action as any)?.data?.linkId;
          if (candidate != null) linkId = String(candidate);
          break;
        }
        if (linkId != null) break;
      }

      const next = prev.map((row) => ({
        ...row,
        actions: (row.actions ?? []).filter((action) => {
          if (String((action as any)?.id) === selectedActionId) return false;
          if (linkId && String((action as any)?.data?.linkId ?? '') === linkId) return false;
          return true;
        }),
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

      // If this is a linked clip (video <-> embedded audio), we split BOTH so the link stays intact.
      const foundLinkId = (foundAction as any)?.data?.linkId ? String((foundAction as any).data.linkId) : null;
      let partnerRowIndex = -1;
      let partnerActionIndex = -1;
      let partnerAction: CustomTimelineAction | null = null;

      if (foundLinkId) {
        for (let rowIndex = 0; rowIndex < prev.length; rowIndex++) {
          const row = prev[rowIndex];
          const actions = Array.isArray(row?.actions) ? row.actions : [];
          for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
            const action = actions[actionIndex] as unknown as CustomTimelineAction;
            if (String(action?.id) === selectedActionId) continue;
            if (String((action as any)?.data?.linkId ?? '') !== foundLinkId) continue;
            partnerRowIndex = rowIndex;
            partnerActionIndex = actionIndex;
            partnerAction = action;
            break;
          }
          if (partnerAction) break;
        }
      }

      const start = Number(foundAction.start);
      const end = Number(foundAction.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return prev;
      if (!(start < cursorTime && cursorTime < end)) return prev;

      pushHistory(prev);

      // Generate new link ids so we end up with two linked pairs (left and right).
      const leftLinkId = foundLinkId && partnerAction ? `link-${uid()}` : foundLinkId;
      const rightLinkId = foundLinkId && partnerAction ? `link-${uid()}` : foundLinkId;

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
        data: { ...(foundAction as any).data, offset: currentOffset, linkId: leftLinkId ?? undefined },
      };
      const right: CustomTimelineAction = {
        ...foundAction,
        start: cursorTime,
        end,
        id: rightActionId,
        data: { ...(foundAction as any).data, offset: rightOffset, linkId: rightLinkId ?? undefined },
      };

      const next = structuredClone(prev) as CusTomTimelineRow[];
      const nextRow = next[foundRowIndex];
      const nextActions = Array.isArray(nextRow.actions) ? [...nextRow.actions] : [];
      nextActions.splice(foundActionIndex, 1, left, right);
      nextActions.sort((a, b) => Number((a as any).start) - Number((b as any).start));
      nextRow.actions = nextActions as any;

      if (partnerAction && partnerRowIndex >= 0 && partnerActionIndex >= 0) {
        const pStart = Number((partnerAction as any).start);
        const pEnd = Number((partnerAction as any).end);
        if (Number.isFinite(pStart) && Number.isFinite(pEnd) && pStart === start && pEnd === end) {
          const partnerRightId = `${String((partnerAction as any).id)}-r-${uid()}`;
          const partnerLeft: CustomTimelineAction = {
            ...partnerAction,
            start,
            end: cursorTime,
            id: (partnerAction as any).id,
            data: { ...(partnerAction as any).data, linkId: leftLinkId ?? undefined },
          };
          const partnerRight: CustomTimelineAction = {
            ...partnerAction,
            start: cursorTime,
            end,
            id: partnerRightId,
            data: { ...(partnerAction as any).data, linkId: rightLinkId ?? undefined },
          };

          const partnerRow = next[partnerRowIndex];
          const partnerActions = Array.isArray(partnerRow.actions) ? [...partnerRow.actions] : [];
          partnerActions.splice(partnerActionIndex, 1, partnerLeft, partnerRight);
          partnerActions.sort((a, b) => Number((a as any).start) - Number((b as any).start));
          partnerRow.actions = partnerActions as any;
        }
      }

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
            muted
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
            onActionMoveStart={({ action }) => {
              pendingGestureActionIdRef.current = String((action as any)?.id ?? '');
              snapStateRef.current = { actionId: String((action as any)?.id ?? ''), edge: null };

              const start = Number((action as any)?.start);
              const end = Number((action as any)?.end);
              gestureRef.current = {
                actionId: String((action as any)?.id ?? ''),
                mode: 'move',
                dir: null,
                basePointerTime: null,
                lastPointerTime: null,
                initialStart: Number.isFinite(start) ? start : 0,
                initialEnd: Number.isFinite(end) ? end : 0,
                takeover: false,
              };
              attachGesturePointerTracking();

              if (pendingHistoryBeforeRef.current) return;
              pendingHistoryBeforeRef.current = structuredClone(data) as CusTomTimelineRow[];
              pendingHistorySignatureRef.current = getTimelineSignature(data);
            }}
            onActionMoveEnd={() => {
              const pendingBefore = pendingHistoryBeforeRef.current;
              const pendingSig = pendingHistorySignatureRef.current;
              if (pendingBefore && pendingSig) {
                const nextSig = getTimelineSignature(dataRef.current);
                if (nextSig !== pendingSig) pushHistory(pendingBefore);
              }
              pendingHistoryBeforeRef.current = null;
              pendingHistorySignatureRef.current = null;
              pendingGestureActionIdRef.current = null;
              snapStateRef.current = { actionId: null, edge: null };

              gestureRef.current = {
                actionId: null,
                mode: null,
                dir: null,
                basePointerTime: null,
                lastPointerTime: null,
                initialStart: 0,
                initialEnd: 0,
                takeover: false,
              };
              detachGesturePointerTracking();
            }}
            onActionResizeStart={({ action }) => {
              pendingGestureActionIdRef.current = String((action as any)?.id ?? '');
              snapStateRef.current = { actionId: String((action as any)?.id ?? ''), edge: null };

              const start = Number((action as any)?.start);
              const end = Number((action as any)?.end);
              gestureRef.current = {
                actionId: String((action as any)?.id ?? ''),
                mode: 'resize',
                dir: null,
                basePointerTime: null,
                lastPointerTime: null,
                initialStart: Number.isFinite(start) ? start : 0,
                initialEnd: Number.isFinite(end) ? end : 0,
                takeover: false,
              };
              attachGesturePointerTracking();

              if (pendingHistoryBeforeRef.current) return;
              pendingHistoryBeforeRef.current = structuredClone(data) as CusTomTimelineRow[];
              pendingHistorySignatureRef.current = getTimelineSignature(data);
            }}
            onActionResizeEnd={() => {
              const pendingBefore = pendingHistoryBeforeRef.current;
              const pendingSig = pendingHistorySignatureRef.current;
              if (pendingBefore && pendingSig) {
                const nextSig = getTimelineSignature(dataRef.current);
                if (nextSig !== pendingSig) pushHistory(pendingBefore);
              }
              pendingHistoryBeforeRef.current = null;
              pendingHistorySignatureRef.current = null;
              pendingGestureActionIdRef.current = null;
              snapStateRef.current = { actionId: null, edge: null };

              gestureRef.current = {
                actionId: null,
                mode: null,
                dir: null,
                basePointerTime: null,
                lastPointerTime: null,
                initialStart: 0,
                initialEnd: 0,
                takeover: false,
              };
              detachGesturePointerTracking();
            }}
            onActionMoving={({ action, row, start, end }) => {
            const actionId = String((action as any)?.id ?? '');
            const g = gestureRef.current;

            // If we are in takeover mode for this gesture, drive movement from pointer tracking.
            if (g.takeover && g.mode === 'move' && g.actionId === actionId) {
              const base = g.basePointerTime;
              const last = g.lastPointerTime;
              const delta = base != null && last != null ? last - base : 0;
              const proposedStart = g.initialStart + delta;
              const proposedEnd = g.initialEnd + delta;
              const snapped = maybeSnapToCursorForMove(actionId, proposedStart, proposedEnd);
              const nextStart = snapped.start;
              const nextEnd = snapped.end;

              const typedRow = row as CusTomTimelineRow;
              if (wouldOverlapInRow(typedRow, String(action.id), nextStart, nextEnd)) return false;

              const currentRows = dataRef.current;
              const partner = findLinkedPartner(currentRows, String(action.id));
              if (partner) {
                const partnerRow = currentRows[partner.rowIndex];
                if (partnerRow && wouldOverlapInRow(partnerRow, String(partner.action.id), nextStart, nextEnd)) return false;
              }

              setData((prev) => {
                const updated = partner
                  ? setStartEndForActionAndLinked(prev, String(action.id), nextStart, nextEnd)
                  : setStartEndForActionOnly(prev, String(action.id), nextStart, nextEnd);
                dataRef.current = updated;
                return updated;
              });

              // Always block the library while in takeover.
              return false;
            }

            const rawStart = Number(start);
            const rawEnd = Number(end);
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return false;
            if (rawEnd <= rawStart) return false;

            const snapped = maybeSnapToCursorForMove(actionId, rawStart, rawEnd);
            const nextStart = snapped.start;
            const nextEnd = snapped.end;
            if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return false;
            if (nextEnd <= nextStart) return false;

            const typedRow = row as CusTomTimelineRow;
            if (wouldOverlapInRow(typedRow, String(action.id), nextStart, nextEnd)) return false;

            // Linked clips (video <-> embedded audio): ensure the partner row won't overlap either.
            const currentRows = dataRef.current;
            const partner = findLinkedPartner(currentRows, String(action.id));
            if (partner) {
              const partnerRow = currentRows[partner.rowIndex];
              if (partnerRow && wouldOverlapInRow(partnerRow, String(partner.action.id), nextStart, nextEnd)) return false;
            }

            // Live visual sync:
            // - If linked: update both.
            // - If snapped (even if not linked): force the dragged clip to the snapped range.
            if (partner || snapped.snapped) {
              setData((prev) => {
                const updated = partner
                  ? setStartEndForActionAndLinked(prev, String(action.id), nextStart, nextEnd)
                  : setStartEndForActionOnly(prev, String(action.id), nextStart, nextEnd);
                dataRef.current = updated;
                return updated;
              });
            }

            // IMPORTANT: when snapped, prevent the timeline lib from applying its own drag position.
            // This makes the actively-dragged clip stick visually to the cursor magnet.
            if (snapped.snapped) {
              // Take over for the rest of this drag gesture so we can also detect "pull away" and release.
              const base = gestureRef.current.lastPointerTime;
              gestureRef.current = {
                actionId,
                mode: 'move',
                dir: null,
                basePointerTime: base,
                lastPointerTime: gestureRef.current.lastPointerTime,
                initialStart: rawStart,
                initialEnd: rawEnd,
                takeover: true,
              };
              attachGesturePointerTracking();
              return false;
            }
          }}
            onActionResizing={({ action, row, start, end, dir }) => {
            const actionId = String((action as any)?.id ?? '');
            const g = gestureRef.current;

            const resizeDir = (dir as 'left' | 'right') ?? 'right';

            if (g.takeover && g.mode === 'resize' && g.actionId === actionId) {
              const base = g.basePointerTime;
              const last = g.lastPointerTime;
              const delta = base != null && last != null ? last - base : 0;

              const proposedStart = resizeDir === 'left' ? g.initialStart + delta : g.initialStart;
              const proposedEnd = resizeDir === 'right' ? g.initialEnd + delta : g.initialEnd;

              const snapped = maybeSnapToCursorForResize(actionId, proposedStart, proposedEnd, resizeDir);
              const nextStart = snapped.start;
              const nextEnd = snapped.end;

              const typedRow = row as CusTomTimelineRow;
              if (wouldOverlapInRow(typedRow, String(action.id), nextStart, nextEnd)) return false;

              const currentRows = dataRef.current;
              const partner = findLinkedPartner(currentRows, String(action.id));
              if (partner) {
                const partnerRow = currentRows[partner.rowIndex];
                if (partnerRow && wouldOverlapInRow(partnerRow, String(partner.action.id), nextStart, nextEnd)) return false;
              }

              setData((prev) => {
                const updated = partner
                  ? setStartEndForActionAndLinked(prev, String(action.id), nextStart, nextEnd)
                  : setStartEndForActionOnly(prev, String(action.id), nextStart, nextEnd);
                dataRef.current = updated;
                return updated;
              });

              return false;
            }

            const rawStart = Number(start);
            const rawEnd = Number(end);
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return false;
            if (rawEnd <= rawStart) return false;

            const snapped = maybeSnapToCursorForResize(actionId, rawStart, rawEnd, resizeDir);
            const nextStart = snapped.start;
            const nextEnd = snapped.end;
            if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return false;
            if (nextEnd <= nextStart) return false;

            const typedRow = row as CusTomTimelineRow;
            if (wouldOverlapInRow(typedRow, String(action.id), nextStart, nextEnd)) return false;

            const currentRows = dataRef.current;
            const partner = findLinkedPartner(currentRows, String(action.id));
            if (partner) {
              const partnerRow = currentRows[partner.rowIndex];
              if (partnerRow && wouldOverlapInRow(partnerRow, String(partner.action.id), nextStart, nextEnd)) return false;
            }

            if (partner || snapped.snapped) {
              setData((prev) => {
                const updated = partner
                  ? setStartEndForActionAndLinked(prev, String(action.id), nextStart, nextEnd)
                  : setStartEndForActionOnly(prev, String(action.id), nextStart, nextEnd);
                dataRef.current = updated;
                return updated;
              });
            }

            if (snapped.snapped) {
              const base = gestureRef.current.lastPointerTime;
              gestureRef.current = {
                actionId,
                mode: 'resize',
                dir: resizeDir,
                basePointerTime: base,
                lastPointerTime: gestureRef.current.lastPointerTime,
                initialStart: rawStart,
                initialEnd: rawEnd,
                takeover: true,
              };
              attachGesturePointerTracking();
              return false;
            }
          }}
            onChange={(data) => {
              const nextClean = cleanEditorData(data as CusTomTimelineRow[]);
              const sourceActionId = pendingGestureActionIdRef.current;
              const nextLinked = sourceActionId ? applyLinkedStartEnd(nextClean, sourceActionId) : nextClean;
              setData(nextLinked);

              // If this onChange is the result of a drag/resize gesture, record a single history entry.
              const pendingBefore = pendingHistoryBeforeRef.current;
              const pendingSig = pendingHistorySignatureRef.current;
              if (pendingBefore && pendingSig) {
                const nextSig = getTimelineSignature(nextLinked);
                if (nextSig !== pendingSig) pushHistory(pendingBefore);
                pendingHistoryBeforeRef.current = null;
                pendingHistorySignatureRef.current = null;
              }
            }}
            getActionRender={(action, row) => {
              if (action.effectId === 'effect0') {
                return <CustomRender0 action={action as CustomTimelineAction} row={row as CusTomTimelineRow} />;
              } else if (action.effectId === 'effect2') {
                return <CustomRender2 action={action as CustomTimelineAction} row={row as CusTomTimelineRow} />;
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