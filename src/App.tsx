import { Timeline } from '@xzdarcy/react-timeline-editor';
import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CustomRender0, CustomRender1, CustomRender2 } from './custom';
import './index.less';
import { mockEffect, scale, scaleWidth as baseScaleWidth, startLeft } from './mock';
import type { CustomTimelineAction, CusTomTimelineRow } from './mock';
import type { FootageItem } from './footageBin';
import TimelinePlayer from './player';
import videoControl from './videoControl';
import mediaCache from './mediaCache';
import { useCoarsePointer } from './useCoarsePointer';
import footageIconUrl from './assets/footage.png';
import zoomInIconUrl from './assets/zoom-in.png';
import zoomOutIconUrl from './assets/zoom-out.png';
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

const createEmptyEditorData = (): CusTomTimelineRow[] => [
  { id: '0', actions: [] },
  { id: '1', actions: [] },
  { id: '2', actions: [] },
  { id: '3', actions: [] },
];

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

export type MeliesVideoEditorProps = {
  /**
   * URLs (often blob: URLs) to show in the footage bin.
   * When omitted or empty, the footage bin will be empty.
   */
  footageUrls?: string[];

  /**
   * When true, automatically place `footageUrls` onto the timeline on first initialization
   * (one after another, starting at t=0).
   *
   * Defaults to false.
   */
  autoPlaceFootage?: boolean;
};

const inferFootageKindFromUrl = (url: string): FootageItem['kind'] => {
  const u = String(url ?? '').toLowerCase();
  if (u.match(/\.(mp3|wav|m4a|aac|ogg)(\?|#|$)/)) return 'audio';
  return 'video';
};

const nameFromUrl = (url: string, index: number) => {
  try {
    const last = String(url ?? '').split('/').pop() || '';
    const clean = decodeURIComponent(last.split('?')[0].split('#')[0]);
    return clean || `Footage ${index + 1}`;
  } catch {
    return `Footage ${index + 1}`;
  }
};

const MeliesVideoEditor = ({ footageUrls, autoPlaceFootage = false }: MeliesVideoEditorProps) => {
  const [data, setData] = useState<CusTomTimelineRow[]>(() => createEmptyEditorData());
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [past, setPast] = useState<CusTomTimelineRow[][]>([]);
  const [future, setFuture] = useState<CusTomTimelineRow[][]>([]);
  const dataRef = useRef<CusTomTimelineRow[]>(data);
  const isMobile = useCoarsePointer();
  const [isFootageBinOpen, setIsFootageBinOpen] = useState(false);
  const timelineState = useRef<TimelineState | null>(null);
  const playerPanel = useRef<HTMLDivElement | null>(null);
  const timelineWrapRef = useRef<HTMLDivElement | null>(null);
  const autoScrollWhenPlay = useRef<boolean>(true);

  const footageBin = useMemo<FootageItem[]>(() => {
    const urls = Array.isArray(footageUrls) ? footageUrls.filter(Boolean) : [];
    if (!urls.length) return [];
    return urls.map((src, index) => ({
      id: `url-${index}`,
      kind: inferFootageKindFromUrl(src),
      name: nameFromUrl(src, index),
      src,
      defaultDuration: 10,
    }));
  }, [footageUrls]);

  const [activeFootage, setActiveFootage] = useState<FootageItem | null>(null);
  const [activeFootageSize, setActiveFootageSize] = useState<{ width: number; height: number } | null>(null);
  const [hoveredDropRowIndex, setHoveredDropRowIndex] = useState<number | null>(null);
  const [laneScrollTop, setLaneScrollTop] = useState(0);
  const [laneScrollLeft, setLaneScrollLeft] = useState(0);
  const [editAreaOffsetTop, setEditAreaOffsetTop] = useState(0);
  const [editAreaOffsetLeft, setEditAreaOffsetLeft] = useState(0);
  const [isDragOverTimeline, setIsDragOverTimeline] = useState(false);
  const [dragClient, setDragClient] = useState<{ x: number; y: number } | null>(null);
  const lastDragClientRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const timelinePointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const cursorDraggingRef = useRef<{ pointerId: number } | null>(null);

  const [timelineScaleWidth, setTimelineScaleWidth] = useState(baseScaleWidth);
  const MIN_SCALE_WIDTH = 80;
  const MAX_SCALE_WIDTH = 480;
  const ZOOM_FACTOR = 1.25;
  const pendingZoomScrollLeftRef = useRef<number | null>(null);
  const lastZoomPointerDownMsRef = useRef<number>(0);

  // After zooming changes scaleWidth, apply the new scrollLeft once the Timeline has re-laid out.
  useLayoutEffect(() => {
    const pending = pendingZoomScrollLeftRef.current;
    if (pending == null) return;
    pendingZoomScrollLeftRef.current = null;

    timelineState.current?.setScrollLeft(pending);

    // Ensure our laneScrollLeft state matches the DOM scrollLeft the timeline actually ended up with.
    requestAnimationFrame(() => {
      setLaneScrollLeft(getTimelineScrollLeft());
    });
  }, [timelineScaleWidth]);

  const ROW_HEIGHT_PX = isMobile ? 48 : 32;

  // Lane layout (row indexes) used by this app.
  // 0: V1
  // 1: V2
  // Row layout (array order = visual top -> bottom).
  // We want higher logical track numbers to appear visually higher.
  // For a 4-row layout the visual top->bottom will be: V2, V1, A2, A1
  // VIDEO_ROW_INDEXES: [indexOfV1, indexOfV2]
  // AUDIO_ROW_INDEXES: [indexOfA1, indexOfA2]
  const VIDEO_ROW_INDEXES = [1, 0] as const;
  const AUDIO_ROW_INDEXES = [3, 2] as const;
  const LANE_LABELS = ['V2', 'V1', 'A2', 'A1'] as const;

  const pickNearestRowIndex = (rawRowIndex: number | null, candidateIndexes: readonly number[]) => {
    if (candidateIndexes.length === 0) return null;
    if (rawRowIndex == null) return candidateIndexes[0];
    let best = candidateIndexes[0];
    let bestDist = Math.abs(rawRowIndex - best);
    for (const idx of candidateIndexes) {
      const dist = Math.abs(rawRowIndex - idx);
      if (dist < bestDist) {
        best = idx;
        bestDist = dist;
      }
    }
    return best;
  };

  const pickLaneForItem = (item: FootageItem | null, rawRowIndex: number | null) => {
    if (!item) return null;
    if (item.kind === 'video') return pickNearestRowIndex(rawRowIndex, VIDEO_ROW_INDEXES);
    return pickNearestRowIndex(rawRowIndex, AUDIO_ROW_INDEXES);
  };

  const pairedAudioRowForVideoRow = (videoRowIndex: number) => {
    // Keep video + its embedded audio together by pairing V1->A1 and V2->A2.
    return videoRowIndex === VIDEO_ROW_INDEXES[1] ? AUDIO_ROW_INDEXES[1] : AUDIO_ROW_INDEXES[0];
  };

  const pairedVideoRowForAudioRow = (audioRowIndex: number) => {
    // Inverse of pairedAudioRowForVideoRow.
    return audioRowIndex === AUDIO_ROW_INDEXES[1] ? VIDEO_ROW_INDEXES[1] : VIDEO_ROW_INDEXES[0];
  };

  const normalizeRowIndexForKind = (rawRowIndex: number, kind: 'video' | 'audio') => {
    const candidates = kind === 'video' ? VIDEO_ROW_INDEXES : AUDIO_ROW_INDEXES;
    return pickNearestRowIndex(rawRowIndex, candidates) ?? candidates[0];
  };

  const hasAutoPlacedFootageRef = useRef(false);

  useEffect(() => {
    if (!autoPlaceFootage) return;
    if (hasAutoPlacedFootageRef.current) return;
    if (footageBin.length === 0) return;

    const rowsNow = dataRef.current;
    const hasAnyActions = rowsNow.some((r) => Array.isArray(r?.actions) && r.actions.length > 0);
    if (hasAnyActions) return;

    const targetVideoRow = VIDEO_ROW_INDEXES[0];
    const targetAudioRow = pairedAudioRowForVideoRow(targetVideoRow);

    const next = createEmptyEditorData();
    let t = 0;
    for (const item of footageBin) {
      const duration = Math.max(0.01, Number(item.defaultDuration ?? 10));
      const start = t;
      const end = t + duration;
      t = end;

      if (item.kind === 'video') {
        const linkId = `link-${uid()}`;
        // videoLayer: higher number = visually higher track. Compute based on VIDEO_ROW_INDEXES mapping.
        const layerForTarget = VIDEO_ROW_INDEXES.findIndex((x) => x === targetVideoRow);
        next[targetVideoRow].actions.push({
          id: `video-${uid()}`,
          start,
          end,
          effectId: 'effect1',
          data: {
            src: item.src,
            previewSrc: item.previewSrc,
            name: item.name,
            linkId,
            videoLayer: layerForTarget,
          },
        } as CustomTimelineAction);

        next[targetAudioRow].actions.push({
          id: `video-audio-${uid()}`,
          start,
          end,
          effectId: 'effect2',
          data: {
            src: item.src,
            name: item.name,
            linkId,
          },
        } as CustomTimelineAction);
      } else {
        next[targetAudioRow].actions.push({
          id: `audio-${uid()}`,
          start,
          end,
          effectId: 'effect0',
          data: {
            src: item.src,
            name: item.name,
          },
        } as CustomTimelineAction);
      }
    }

    setSelectedActionId(null);
    setPast([]);
    setFuture([]);
    setData(() => {
      dataRef.current = next;
      return next;
    });

    hasAutoPlacedFootageRef.current = true;
  }, [autoPlaceFootage, footageBin]);

  // Preload media referenced by timeline actions to reduce buffering/stalls during playback.
  // This is intentionally fire-and-forget; cache dedupes across edits.
  useEffect(() => {
    mediaCache.warmFromEditorData(data);
  }, [data]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useLayoutEffect(() => {
    const root = timelineWrapRef.current;
    if (!root) return;

    const measure = () => {
      const wrapRect = root.getBoundingClientRect();
      const editArea = root.querySelector('.timeline-editor-edit-area') as HTMLElement | null;
      if (!editArea) return;
      const editRect = editArea.getBoundingClientRect();
      setEditAreaOffsetTop(editRect.top - wrapRect.top);
      setEditAreaOffsetLeft(editRect.left - wrapRect.left);
    };

    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [isMobile, data.length]);

  const isPointOverTimeline = (pt: { x: number; y: number } | null) => {
    const root = timelineWrapRef.current;
    if (!root || !pt) return false;
    const rect = root.getBoundingClientRect();
    return pt.x >= rect.left && pt.x <= rect.right && pt.y >= rect.top && pt.y <= rect.bottom;
  };

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
    // Used to detect intentional vertical lane switches.
    basePointerClientY: number | null;
    lastPointerClientY: number | null;
    initialRowIndex: number;
    committedRowIndex: number;
    laneCandidateRowIndex: number | null;
    laneCandidateSinceMs: number;
    laneIntentRowIndex: number | null;
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
    basePointerClientY: null,
    lastPointerClientY: null,
    initialRowIndex: 0,
    committedRowIndex: 0,
    laneCandidateRowIndex: null,
    laneCandidateSinceMs: 0,
    laneIntentRowIndex: null,
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

  /**
   * Reconcile lane placement for actions so:
   * - video clips always live in a video lane (V1/V2)
   * - audio clips always live in an audio lane (A1/A2)
   * - linked pairs (video<->embedded audio) stay paired across lanes when either is moved
   * - videoLayer is updated when a video clip moves between V lanes
   */
  const reconcileLanePlacement = (rows: CusTomTimelineRow[], sourceActionId: string | null) => {
    const safeRows = structuredClone(rows) as CusTomTimelineRow[];
    while (safeRows.length < 4) safeRows.push({ id: `${safeRows.length}`, actions: [] } as unknown as CusTomTimelineRow);

    const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
    const getField = (obj: unknown, key: string) => {
      if (!obj || typeof obj !== 'object') return undefined;
      return (obj as Record<string, unknown>)[key];
    };

    const getActionId = (a: CustomTimelineAction) => String(getField(a as unknown, 'id') ?? '');
    const getEffectId = (a: CustomTimelineAction) => String(getField(a as unknown, 'effectId') ?? '');
    const getStart = (a: CustomTimelineAction) => Number(getField(a as unknown, 'start'));
    const getEnd = (a: CustomTimelineAction) => Number(getField(a as unknown, 'end'));
    const getData = (a: CustomTimelineAction) => getField(a as unknown, 'data');
    const startOfUnknown = (a: unknown) => {
      if (!a || typeof a !== 'object') return 0;
      const n = Number((a as Record<string, unknown>).start);
      return Number.isFinite(n) ? n : 0;
    };

    type Found = { rowIndex: number; actionIndex: number; action: CustomTimelineAction };
    const foundById = new Map<string, Found>();
    const linkGroups = new Map<string, { video?: Found; audio?: Found }>();

    for (let rowIndex = 0; rowIndex < safeRows.length; rowIndex++) {
      const row = safeRows[rowIndex];
      const actions = Array.isArray(row?.actions) ? row.actions : [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
        const action = actions[actionIndex] as unknown as CustomTimelineAction;
        const id = getActionId(action);
        if (!id) continue;

        foundById.set(id, { rowIndex, actionIndex, action });

        const data = getData(action);
        const linkIdRaw = getField(data, 'linkId');
        const linkId = linkIdRaw != null ? String(linkIdRaw) : '';
        if (!linkId) continue;

        const group = linkGroups.get(linkId) ?? {};
        const effectId = getEffectId(action);
        if (effectId === 'effect1') group.video = { rowIndex, actionIndex, action };
        else if (effectId === 'effect2') group.audio = { rowIndex, actionIndex, action };
        linkGroups.set(linkId, group);
      }
    }

    const instructions = new Map<
      string,
      {
        targetRowIndex: number;
        patchStartEnd?: { start: number; end: number };
        patchVideoLayer?: number;
      }
    >();

    // First reconcile linked pairs.
    for (const group of linkGroups.values()) {
      if (!group.video || !group.audio) continue;

      const videoId = getActionId(group.video.action);
      const audioId = getActionId(group.audio.action);
      const basis: 'video' | 'audio' = sourceActionId && String(sourceActionId) === audioId ? 'audio' : 'video';

      const vRow = basis === 'audio'
        ? pairedVideoRowForAudioRow(normalizeRowIndexForKind(group.audio.rowIndex, 'audio'))
        : normalizeRowIndexForKind(group.video.rowIndex, 'video');
      const aRow = pairedAudioRowForVideoRow(vRow);

      const basisAction = basis === 'audio' ? group.audio.action : group.video.action;
      const nextStart = getStart(basisAction);
      const nextEnd = getEnd(basisAction);
      const validRange = Number.isFinite(nextStart) && Number.isFinite(nextEnd) && nextEnd > nextStart;

      const layerForV = Math.max(0, VIDEO_ROW_INDEXES.findIndex((x) => x === vRow));

      instructions.set(videoId, {
        targetRowIndex: vRow,
        patchStartEnd: validRange ? { start: nextStart, end: nextEnd } : undefined,
        patchVideoLayer: layerForV,
      });
      instructions.set(audioId, {
        targetRowIndex: aRow,
        patchStartEnd: validRange ? { start: nextStart, end: nextEnd } : undefined,
      });
    }

    // Then normalize any remaining actions to the relevant lane type.
    for (const [id, found] of foundById.entries()) {
      if (instructions.has(id)) continue;
      const effectId = getEffectId(found.action);

      if (effectId === 'effect1') {
        const vRow = normalizeRowIndexForKind(found.rowIndex, 'video');
        const layerForV = Math.max(0, VIDEO_ROW_INDEXES.findIndex((x) => x === vRow));
        instructions.set(id, { targetRowIndex: vRow, patchVideoLayer: layerForV });
      } else if (effectId === 'effect0' || effectId === 'effect2') {
        const aRow = normalizeRowIndexForKind(found.rowIndex, 'audio');
        instructions.set(id, { targetRowIndex: aRow });
      }
    }

    // Rebuild rows based on instructions.
    const rebuilt = safeRows.map((row) => ({ ...row, actions: [] as unknown as CusTomTimelineRow['actions'] } as CusTomTimelineRow));
    let changed = false;

    for (let rowIndex = 0; rowIndex < safeRows.length; rowIndex++) {
      const row = safeRows[rowIndex];
      const actions = Array.isArray(row?.actions) ? row.actions : [];
      for (const rawAction of actions) {
        const action = rawAction as unknown as CustomTimelineAction;
        const id = getActionId(action);
        if (!id) continue;

        const inst = instructions.get(id);
        const targetRowIndex = inst ? inst.targetRowIndex : rowIndex;
        const target = rebuilt[targetRowIndex] ?? rebuilt[rowIndex];

        let out: CustomTimelineAction = action;

        if (inst?.patchStartEnd) {
          const nextStart = inst.patchStartEnd.start;
          const nextEnd = inst.patchStartEnd.end;
          if (getStart(out) !== nextStart || getEnd(out) !== nextEnd) {
            out = { ...asRecord(out), start: nextStart, end: nextEnd } as unknown as CustomTimelineAction;
            changed = true;
          }
        }

        if (inst?.patchVideoLayer != null && getEffectId(out) === 'effect1') {
          const existing = Number(getField(getData(out), 'videoLayer'));
          if (!Number.isFinite(existing) || existing !== inst.patchVideoLayer) {
            const nextData = { ...asRecord(getData(out)), videoLayer: inst.patchVideoLayer };
            out = { ...asRecord(out), data: nextData } as unknown as CustomTimelineAction;
            changed = true;
          }
        }

        if (targetRowIndex !== rowIndex) changed = true;
        (target.actions as unknown as CustomTimelineAction[]).push(out);
      }
    }

    for (const row of rebuilt) {
      const actions = Array.isArray(row.actions) ? [...row.actions] : [];
      actions.sort((a, b) => startOfUnknown(a) - startOfUnknown(b));
      row.actions = actions as unknown as CusTomTimelineRow['actions'];
    }

    return changed ? rebuilt : rows;
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

  const insertActionAtTime = (
    item: { kind: 'video' | 'audio'; src: string; previewSrc?: string; name: string; defaultDuration?: number },
    at: number,
    targetRowIndex?: number | null
  ) => {
    const duration = item.defaultDuration ?? 10;
    let start = Math.max(0, at);
    let end = start + duration;

    const state = timelineState.current;
    if (state?.isPlaying) state.pause();

    setData((prev) => {
      pushHistory(prev);
      const next = structuredClone(prev) as CusTomTimelineRow[];

      // Ensure we have at least 4 lanes: V1, V2, A1, A2
      while (next.length < 4) next.push({ id: `${next.length}`, actions: [] } as unknown as CusTomTimelineRow);

      const raw = Number.isFinite(Number(targetRowIndex)) ? Number(targetRowIndex) : null;
      const chosenVideoRowIndex = pickNearestRowIndex(raw, VIDEO_ROW_INDEXES) ?? VIDEO_ROW_INDEXES[0];
      const chosenAudioRowIndex = pickNearestRowIndex(raw, AUDIO_ROW_INDEXES) ?? AUDIO_ROW_INDEXES[0];

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
        // Video drops go to the nearest video lane; its embedded audio goes to the paired audio lane.
        const vRow = chosenVideoRowIndex;
        const aRow = pairedAudioRowForVideoRow(vRow);
        bumpStartToAvoidOverlaps([vRow, aRow]);

        const linkId = `link-${uid()}`;
        const clipId = `video-${uid()}`;
        const audioId = `video-audio-${uid()}`;

        const layerForV = VIDEO_ROW_INDEXES.findIndex((x) => x === vRow);
        next[vRow].actions = [
          ...(next[vRow].actions ?? []),
          {
            id: clipId,
            start,
            end,
            effectId: 'effect1',
            data: { src: item.src, previewSrc: item.previewSrc, name: item.name, linkId, videoLayer: layerForV },
          } as CustomTimelineAction,
        ];

        next[aRow].actions = [
          ...(next[aRow].actions ?? []),
          {
            id: audioId,
            start,
            end,
            effectId: 'effect2',
            data: { src: item.src, name: item.name, linkId },
          } as CustomTimelineAction,
        ];
      } else {
        // Audio drops go to the nearest audio lane.
        const aRow = chosenAudioRowIndex;
        bumpStartToAvoidOverlaps([aRow]);
        next[aRow].actions = [
          ...(next[aRow].actions ?? []),
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

  const getTimelineViewportWidth = () => {
    const root = timelineWrapRef.current;
    if (!root) return null;
    const editArea = root.querySelector('.timeline-editor-edit-area') as HTMLElement | null;
    const rect = (editArea ?? root).getBoundingClientRect();
    const width = Number(rect?.width ?? 0);
    return Number.isFinite(width) && width > 0 ? width : null;
  };

  const zoomToScaleWidth = (nextScaleWidth: number) => {
    const clamped = Math.min(MAX_SCALE_WIDTH, Math.max(MIN_SCALE_WIDTH, Math.round(nextScaleWidth)));
    if (clamped === timelineScaleWidth) return;

    const viewportWidth = getTimelineViewportWidth();
    if (!viewportWidth) {
      setTimelineScaleWidth(clamped);
      return;
    }

    const prevScaleWidth = timelineScaleWidth;
    const scrollLeft = getTimelineScrollLeft();

    // Keep the visual center time stable while zooming.
    const centerPx = scrollLeft + viewportWidth / 2;
    const centerTime = Math.max(0, ((centerPx - startLeft) * scale) / prevScaleWidth);
    const nextCenterPx = startLeft + (centerTime * clamped) / scale;
    const nextScrollLeft = Math.max(0, nextCenterPx - viewportWidth / 2);

    pendingZoomScrollLeftRef.current = nextScrollLeft;
    setTimelineScaleWidth(clamped);
  };

  const zoomIn = () => zoomToScaleWidth(timelineScaleWidth * ZOOM_FACTOR);
  const zoomOut = () => zoomToScaleWidth(timelineScaleWidth / ZOOM_FACTOR);

  const getTimelineScrollTop = () => laneScrollTop;

  const timeFromClientX = (clientX: number) => {
    const root = timelineWrapRef.current;
    if (!root) return 0;
    const editArea = root.querySelector('.timeline-editor-edit-area') as HTMLElement | null;
    const rect = (editArea ?? root).getBoundingClientRect();
    const position = clientX - rect.x;
    const left = position + getTimelineScrollLeft();
    const time = ((left - startLeft) * scale) / timelineScaleWidth;
    return Math.max(0, time);
  };

  const timeToPixel = (t: number) => {
    const time = Number(t);
    if (!Number.isFinite(time)) return 0;
    return startLeft + (time * timelineScaleWidth) / scale;
  };

  const computeBumpedStart = (
    item: FootageItem,
    desiredStart: number,
    laneRowIndex: number,
    rows: CusTomTimelineRow[]
  ): number => {
    const duration = item.defaultDuration ?? 10;
    let start = Math.max(0, desiredStart);
    let end = start + duration;

    const rowIndexes: number[] = [];
    if (item.kind === 'video') {
      // Video: enforce slot free in both the chosen video lane and its paired audio lane.
      const vRow = laneRowIndex;
      const aRow = pairedAudioRowForVideoRow(vRow);
      rowIndexes.push(vRow, aRow);
    } else {
      rowIndexes.push(laneRowIndex);
    }

    const intervals: Array<{ start: number; end: number }> = [];
    for (const idx of rowIndexes) {
      const actions = Array.isArray(rows[idx]?.actions) ? rows[idx].actions : [];
      for (const a of actions) {
        const s = Number((a as any)?.start);
        const e = Number((a as any)?.end);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        intervals.push({ start: s, end: e });
      }
    }
    intervals.sort((a, b) => a.start - b.start);

    for (const other of intervals) {
      if (!rangesOverlap(start, end, other.start, other.end)) continue;
      start = other.end;
      end = start + duration;
    }

    return Math.max(0, start);
  };

  const rowIndexFromClientY = (clientY: number) => {
    const root = timelineWrapRef.current;
    if (!root) return null;
    const editArea = root.querySelector('.timeline-editor-edit-area') as HTMLElement | null;
    if (!editArea) return null;
    const rect = editArea.getBoundingClientRect();
    const position = clientY - rect.y;
    if (position < 0 || position > rect.height) return null;
    const y = position + getTimelineScrollTop();
    const idx = Math.floor(y / ROW_HEIGHT_PX);
    if (!Number.isFinite(idx)) return null;
    const max = Math.max(0, dataRef.current.length - 1);
    return Math.min(Math.max(0, idx), max);
  };

  const getClientXYFromEvent = (ev: Event | null | undefined): { x: number; y: number } | null => {
    if (!ev) return null;

    // PointerEvent/MouseEvent
    if ('clientX' in (ev as any) && 'clientY' in (ev as any)) {
      const x = Number((ev as any).clientX);
      const y = Number((ev as any).clientY);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }

    // TouchEvent
    const touches = (ev as any).touches as TouchList | undefined;
    const changedTouches = (ev as any).changedTouches as TouchList | undefined;
    const t = (touches && touches.length ? touches[0] : null) || (changedTouches && changedTouches.length ? changedTouches[0] : null);
    if (t) {
      const x = Number((t as any).clientX);
      const y = Number((t as any).clientY);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }

    return null;
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

      if (g.basePointerClientY == null) {
        g.basePointerClientY = e.clientY;
      }
      g.lastPointerClientY = e.clientY;
    };

    const onPointerUpOrCancel = () => {
      // pointerup/cancel fires (capture) BEFORE the timeline library calls its end callbacks.
      // If we reset immediately, we lose intent (e.g. lane switch target) before onActionMoveEnd.
      // So we defer cleanup by a frame, and only apply it if the lib didn't.
      const snapshot = {
        actionId: gestureRef.current.actionId,
        mode: gestureRef.current.mode,
      };

      requestAnimationFrame(() => {
        if (gestureRef.current.actionId !== snapshot.actionId) return;
        if (gestureRef.current.mode !== snapshot.mode) return;

        // If the lib misses an end callback, ensure we don't stay stuck in takeover mode.
        gestureRef.current = {
          actionId: null,
          mode: null,
          dir: null,
          basePointerTime: null,
          lastPointerTime: null,
          basePointerClientY: null,
          lastPointerClientY: null,
          initialRowIndex: 0,
          committedRowIndex: 0,
          laneCandidateRowIndex: null,
          laneCandidateSinceMs: 0,
          laneIntentRowIndex: null,
          initialStart: 0,
          initialEnd: 0,
          takeover: false,
        };
        snapStateRef.current = { actionId: null, edge: null };
      });
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

  const suppressNextTimelineOnChangeRef = useRef(false);

  const [moveGhostPreview, setMoveGhostPreview] = useState<
    | {
        actionId: string;
        laneRow: number;
        start: number;
        end: number;
        duration: number;
        kind: 'video' | 'audio';
      }
    | null
  >(null);

  const moveActionToLaneIfValid = (rows: CusTomTimelineRow[], actionId: string, desiredLaneRowIndex: number) => {
    const current = findActionById(rows, actionId);
    if (!current) return rows;

    const effectId = String((current.action as unknown as { effectId?: unknown })?.effectId ?? '');
    const kind: 'video' | 'audio' = effectId === 'effect1' ? 'video' : 'audio';
    const targetMainRow = normalizeRowIndexForKind(desiredLaneRowIndex, kind);

    const partner = findLinkedPartner(rows, actionId);
    const isLinked = Boolean(partner);

    const movingIds = new Set<string>([String(actionId)]);
    if (partner) movingIds.add(String(partner.action.id));

    const mainStart = Number((current.action as unknown as { start?: unknown })?.start);
    const mainEnd = Number((current.action as unknown as { end?: unknown })?.end);
    if (!Number.isFinite(mainStart) || !Number.isFinite(mainEnd) || mainEnd <= mainStart) return rows;

    const canPlaceInRow = (row: CusTomTimelineRow | undefined, start: number, end: number) => {
      const actions = Array.isArray(row?.actions) ? row!.actions : [];
      for (const other of actions) {
        const oid = String((other as unknown as { id?: unknown })?.id ?? '');
        if (oid && movingIds.has(oid)) continue;
        if (rangesOverlap(start, end, Number((other as any)?.start), Number((other as any)?.end))) return false;
      }
      return true;
    };

    let targetVideoRow: number | null = null;
    let targetAudioRow: number | null = null;

    if (isLinked) {
      if (kind === 'video') {
        targetVideoRow = targetMainRow;
        targetAudioRow = pairedAudioRowForVideoRow(targetVideoRow);
      } else {
        targetAudioRow = targetMainRow;
        targetVideoRow = pairedVideoRowForAudioRow(targetAudioRow);
      }
    }

    // Validate no overlap in target rows.
    if (kind === 'video') {
      if (!canPlaceInRow(rows[targetMainRow], mainStart, mainEnd)) return rows;
    } else {
      if (!canPlaceInRow(rows[targetMainRow], mainStart, mainEnd)) return rows;
    }
    if (targetVideoRow != null && !canPlaceInRow(rows[targetVideoRow], mainStart, mainEnd)) return rows;
    if (targetAudioRow != null && !canPlaceInRow(rows[targetAudioRow], mainStart, mainEnd)) return rows;

    // If already in the right lane(s), no-op.
    if (!isLinked && current.rowIndex === targetMainRow) return rows;
    if (isLinked && kind === 'video' && current.rowIndex === targetVideoRow) {
      // Still may need to move partner.
      const partnerNow = partner ? findActionById(rows, String(partner.action.id)) : null;
      if (partnerNow && partnerNow.rowIndex === targetAudioRow) return rows;
    }
    if (isLinked && kind === 'audio' && current.rowIndex === targetAudioRow) {
      const partnerNow = partner ? findActionById(rows, String(partner.action.id)) : null;
      if (partnerNow && partnerNow.rowIndex === targetVideoRow) return rows;
    }

    const next = structuredClone(rows) as CusTomTimelineRow[];
    while (next.length < 4) next.push({ id: `${next.length}`, actions: [] } as unknown as CusTomTimelineRow);

    const removeId = (row: CusTomTimelineRow, id: string) => {
      const actions = Array.isArray(row.actions) ? row.actions : [];
      row.actions = actions.filter((a) => String((a as any)?.id ?? '') !== id) as any;
    };
    const addAction = (rowIndex: number, action: CustomTimelineAction) => {
      const row = next[rowIndex];
      row.actions = [...(row.actions ?? []), action] as any;
      (row.actions as any).sort((a: any, b: any) => Number(a.start) - Number(b.start));
    };

    // Move main
    removeId(next[current.rowIndex], String(actionId));

    let mainOut: CustomTimelineAction = current.action;
    if (kind === 'video') {
      const layerForV = Math.max(0, VIDEO_ROW_INDEXES.findIndex((x) => x === targetMainRow));
      mainOut = {
        ...(mainOut as any),
        data: { ...((mainOut as any).data ?? {}), videoLayer: layerForV },
      };
    }
    addAction(targetMainRow, mainOut);

    // Move partner if linked
    if (partner && targetVideoRow != null && targetAudioRow != null) {
      const partnerFound = findActionById(rows, String(partner.action.id));
      if (partnerFound) {
        removeId(next[partnerFound.rowIndex], String(partner.action.id));
        const partnerTargetRow = kind === 'video' ? targetAudioRow : targetVideoRow;

        let partnerOut: CustomTimelineAction = partnerFound.action;
        const partnerEffect = String((partnerOut as any)?.effectId ?? '');
        if (partnerEffect === 'effect1') {
          const layerForV = Math.max(0, VIDEO_ROW_INDEXES.findIndex((x) => x === partnerTargetRow));
          partnerOut = { ...(partnerOut as any), data: { ...((partnerOut as any).data ?? {}), videoLayer: layerForV } };
        }
        addAction(partnerTargetRow, partnerOut);
      }
    }

    return next;
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
    return data.map((row, rowIndex) => {
      const hasSelected = selectedActionId ? (row.actions ?? []).some((action) => String(action.id) === selectedActionId) : false;
      const isDropHover = activeFootage != null && hoveredDropRowIndex != null && rowIndex === hoveredDropRowIndex;
      const baseClassNames = Array.isArray((row as any).classNames) ? (row as any).classNames : [];
      const classNames = isDropHover ? [...baseClassNames, 'dnd-drop-hover'] : baseClassNames;

      return {
        ...row,
        classNames,
        selected: hasSelected,
        actions: (row.actions ?? []).map((action) => ({
          ...action,
          selected: selectedActionId ? String(action.id) === selectedActionId : false,
        })),
      };
    });
  }, [data, selectedActionId, activeFootage, hoveredDropRowIndex]);

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
          const partnerOffsetRaw = Number((partnerAction as any)?.data?.offset);
          const partnerOffset = Number.isFinite(partnerOffsetRaw) ? partnerOffsetRaw : currentOffset;
          const partnerRightOffset = partnerOffset + (Number.isFinite(splitDelta) ? splitDelta : 0);
          const partnerRightId = `${String((partnerAction as any).id)}-r-${uid()}`;
          const partnerLeft: CustomTimelineAction = {
            ...partnerAction,
            start,
            end: cursorTime,
            id: (partnerAction as any).id,
            data: { ...(partnerAction as any).data, offset: partnerOffset, linkId: leftLinkId ?? undefined },
          };
          const partnerRight: CustomTimelineAction = {
            ...partnerAction,
            start: cursorTime,
            end,
            id: partnerRightId,
            data: { ...(partnerAction as any).data, offset: partnerRightOffset, linkId: rightLinkId ?? undefined },
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

    const pt = getClientXYFromEvent(event.activatorEvent);
    lastDragClientRef.current = pt;
    dragStartClientRef.current = pt;
    setDragClient(pt);
    if (pt) {
      const over = isPointOverTimeline(pt);
      setIsDragOverTimeline(over);
      const raw = rowIndexFromClientY(pt.y);
      setHoveredDropRowIndex(over ? pickLaneForItem(item ?? null, raw) : null);
    } else {
      setHoveredDropRowIndex(null);
      setIsDragOverTimeline(false);
    }

    const initial = event.active.rect.current.initial;
    if (initial) {
      setActiveFootageSize({ width: initial.width, height: initial.height });
    } else {
      setActiveFootageSize(null);
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const initial = event.active.rect.current.initial;
    if (!activeFootageSize && initial) {
      setActiveFootageSize({ width: initial.width, height: initial.height });
    }

    const start = dragStartClientRef.current;
    if (!start) {
      setHoveredDropRowIndex(null);
      return;
    }

    const dx = Number((event as any)?.delta?.x ?? 0);
    const dy = Number((event as any)?.delta?.y ?? 0);
    const pt = { x: start.x + (Number.isFinite(dx) ? dx : 0), y: start.y + (Number.isFinite(dy) ? dy : 0) };
    lastDragClientRef.current = pt;
    setDragClient(pt);

    const over = isPointOverTimeline(pt);
    setIsDragOverTimeline(over);
    const raw = rowIndexFromClientY(pt.y);
    setHoveredDropRowIndex(over ? pickLaneForItem(activeFootage, raw) : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const item = (event.active.data.current as any)?.item as FootageItem | undefined;
    const start = dragStartClientRef.current;
    const dx = Number((event as any)?.delta?.x ?? 0);
    const dy = Number((event as any)?.delta?.y ?? 0);
    const pt = start
      ? { x: start.x + (Number.isFinite(dx) ? dx : 0), y: start.y + (Number.isFinite(dy) ? dy : 0) }
      : lastDragClientRef.current;
    lastDragClientRef.current = pt;

    const overByCollision = String(event.over?.id ?? '') === 'timeline-drop';
    const overTimeline = overByCollision || isPointOverTimeline(pt);
    if (item && overTimeline && pt) {
      const dropTime = timeFromClientX(pt.x);
      const dropRowIndex = rowIndexFromClientY(pt.y);
      const laneRowIndex = pickLaneForItem(item, dropRowIndex);
      setHoveredDropRowIndex(laneRowIndex);
      insertActionAtTime(item, Math.max(0, dropTime), laneRowIndex);
    }

    setActiveFootage(null);
    setActiveFootageSize(null);
    setHoveredDropRowIndex(null);
    setIsDragOverTimeline(false);
    setDragClient(null);
    dragStartClientRef.current = null;
  };

  const handleDragCancel = () => {
    setActiveFootage(null);
    setActiveFootageSize(null);
    setHoveredDropRowIndex(null);
    setIsDragOverTimeline(false);
    setDragClient(null);
    dragStartClientRef.current = null;
  };

  const ghostPreview = useMemo(() => {
    if (!activeFootage) return null;
    if (!isDragOverTimeline) return null;
    const pt = dragClient;
    if (!pt) return null;
    const rawRow = rowIndexFromClientY(pt.y);
    const laneRow = pickLaneForItem(activeFootage, rawRow);
    if (laneRow == null) return null;
    const desiredStart = timeFromClientX(pt.x);
    const bumpedStart = computeBumpedStart(activeFootage, desiredStart, laneRow, dataRef.current);
    const duration = activeFootage.defaultDuration ?? 10;
    return {
      laneRow,
      desiredStart,
      start: bumpedStart,
      end: bumpedStart + duration,
      duration,
      kind: activeFootage.kind,
    };
  }, [activeFootage, isDragOverTimeline, dragClient, laneScrollLeft, laneScrollTop, ROW_HEIGHT_PX]);

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
        <div className="player-stack">
          <div className="footage-ribbon" role="toolbar" aria-label="Footage">
            <button
              type="button"
              className={`footage-ribbon-toggle${isFootageBinOpen ? ' is-open' : ''}`}
              aria-expanded={isFootageBinOpen}
              aria-controls="footage-bin-panel"
              onClick={() => setIsFootageBinOpen((v) => !v)}
            >
              <img src={footageIconUrl} alt="Footage" draggable={false} />
            </button>
          </div>

          <div
            id="footage-bin-panel"
            className={`footage-bin-panel${isFootageBinOpen ? ' is-open' : ''}${activeFootage ? ' is-dragging' : ''}`}
            aria-hidden={!isFootageBinOpen}
          >
            <div className="footage-bin">
              {footageBin.map((item) => (
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
          <div
            className="timeline-lane-labels"
            style={{
              top: editAreaOffsetTop,
              transform: `translateY(${-laneScrollTop}px)`,
              height: ROW_HEIGHT_PX * LANE_LABELS.length,
            }}
          >
            {LANE_LABELS.map((label, idx) => (
              <div
                key={label}
                className={`timeline-lane-label${hoveredDropRowIndex === idx ? ' is-hover' : ''}`}
                style={{ height: ROW_HEIGHT_PX }}
              >
                {label}
              </div>
            ))}
          </div>

          {ghostPreview ? (
            <div className="timeline-ghost-layer" style={{ top: editAreaOffsetTop, left: editAreaOffsetLeft }}>
              {(() => {
                const pxPerSec = timelineScaleWidth / scale;
                const width = ghostPreview.duration * pxPerSec;
                const left = timeToPixel(ghostPreview.start) - laneScrollLeft;

                const clips: Array<{ row: number; kind: 'video' | 'audio' }> = [];
                if (ghostPreview.kind === 'video') {
                  clips.push({ row: ghostPreview.laneRow, kind: 'video' });
                  clips.push({ row: pairedAudioRowForVideoRow(ghostPreview.laneRow), kind: 'audio' });
                } else {
                  clips.push({ row: ghostPreview.laneRow, kind: 'audio' });
                }

                return clips.map((c) => (
                  <div
                    key={`${c.kind}-${c.row}`}
                    className={`timeline-ghost-clip${c.kind === 'video' ? ' is-video' : ' is-audio'}`}
                    style={{
                      left,
                      top: c.row * ROW_HEIGHT_PX - laneScrollTop,
                      width,
                      height: ROW_HEIGHT_PX,
                    }}
                  />
                ));
              })()}
            </div>
          ) : null}

          {moveGhostPreview ? (
            <div className="timeline-ghost-layer" style={{ top: editAreaOffsetTop, left: editAreaOffsetLeft }}>
              {(() => {
                const pxPerSec = timelineScaleWidth / scale;
                const width = moveGhostPreview.duration * pxPerSec;
                const left = timeToPixel(moveGhostPreview.start) - laneScrollLeft;

                const clips: Array<{ row: number; kind: 'video' | 'audio' }> = [];
                if (moveGhostPreview.kind === 'video') {
                  clips.push({ row: moveGhostPreview.laneRow, kind: 'video' });
                  clips.push({ row: pairedAudioRowForVideoRow(moveGhostPreview.laneRow), kind: 'audio' });
                } else {
                  clips.push({ row: moveGhostPreview.laneRow, kind: 'audio' });
                }

                return clips.map((c) => (
                  <div
                    key={`${moveGhostPreview.actionId}-${c.kind}-${c.row}`}
                    className={`timeline-ghost-clip${c.kind === 'video' ? ' is-video' : ' is-audio'}`}
                    style={{
                      left,
                      top: c.row * ROW_HEIGHT_PX - laneScrollTop,
                      width,
                      height: ROW_HEIGHT_PX,
                    }}
                  />
                ));
              })()}
            </div>
          ) : null}

          <div
            className="timeline-zoom-controls"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="timeline-zoom-control"
              onPointerDown={(e) => {
                if (timelineScaleWidth >= MAX_SCALE_WIDTH) return;
                lastZoomPointerDownMsRef.current =
                  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
                e.preventDefault();
                e.stopPropagation();
                zoomIn();
              }}
              onClick={() => {
                const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
                if (now - lastZoomPointerDownMsRef.current < 350) return;
                zoomIn();
              }}
              aria-label="Zoom in"
              title="Zoom in"
              disabled={timelineScaleWidth >= MAX_SCALE_WIDTH}
            >
              <img src={zoomInIconUrl} alt="Zoom in" draggable={false} />
            </button>
            <button
              type="button"
              className="timeline-zoom-control"
              onPointerDown={(e) => {
                if (timelineScaleWidth <= MIN_SCALE_WIDTH) return;
                lastZoomPointerDownMsRef.current =
                  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
                e.preventDefault();
                e.stopPropagation();
                zoomOut();
              }}
              onClick={() => {
                const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
                if (now - lastZoomPointerDownMsRef.current < 350) return;
                zoomOut();
              }}
              aria-label="Zoom out"
              title="Zoom out"
              disabled={timelineScaleWidth <= MIN_SCALE_WIDTH}
            >
              <img src={zoomOutIconUrl} alt="Zoom out" draggable={false} />
            </button>
          </div>

          <Timeline
            scale={scale}
            scaleWidth={timelineScaleWidth}
            startLeft={startLeft}
            rowHeight={ROW_HEIGHT_PX}
            autoScroll={true}
            ref={timelineState}
            editorData={editorDataForRender}
            effects={mockEffect}
            onScroll={(params) => {
              const st = Number((params as any)?.scrollTop ?? 0);
              const sl = Number((params as any)?.scrollLeft ?? 0);
              if (Number.isFinite(st)) setLaneScrollTop(st);
              if (Number.isFinite(sl)) setLaneScrollLeft(sl);
            }}
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

              const actionId = String((action as any)?.id ?? '');
              const found = actionId ? findActionById(dataRef.current, actionId) : null;
              const initialRowIndex = found ? found.rowIndex : 0;

              gestureRef.current = {
                actionId,
                mode: 'move',
                dir: null,
                basePointerTime: null,
                lastPointerTime: null,
                basePointerClientY: null,
                lastPointerClientY: null,
                initialRowIndex,
                committedRowIndex: initialRowIndex,
                laneCandidateRowIndex: null,
                laneCandidateSinceMs: 0,
                laneIntentRowIndex: null,
                initialStart: Number.isFinite(start) ? start : 0,
                initialEnd: Number.isFinite(end) ? end : 0,
                takeover: true,
              };
              attachGesturePointerTracking();

              setMoveGhostPreview(null);

              if (pendingHistoryBeforeRef.current) return;
              pendingHistoryBeforeRef.current = structuredClone(data) as CusTomTimelineRow[];
              pendingHistorySignatureRef.current = getTimelineSignature(data);
            }}
            onActionMoveEnd={() => {
              const g = gestureRef.current;
              const actionId = String(g.actionId ?? '');
              const intentRow = g.laneIntentRowIndex;

              if (actionId && intentRow != null) {
                suppressNextTimelineOnChangeRef.current = true;
                setData((prev) => {
                  const moved = moveActionToLaneIfValid(prev, actionId, intentRow);
                  dataRef.current = moved;
                  return moved;
                });
              }

              setMoveGhostPreview(null);

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
                basePointerClientY: null,
                lastPointerClientY: null,
                initialRowIndex: 0,
                committedRowIndex: 0,
                laneCandidateRowIndex: null,
                laneCandidateSinceMs: 0,
                laneIntentRowIndex: null,
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

              const actionId = String((action as any)?.id ?? '');
              const found = actionId ? findActionById(dataRef.current, actionId) : null;
              const initialRowIndex = found ? found.rowIndex : 0;

              gestureRef.current = {
                actionId,
                mode: 'resize',
                dir: null,
                basePointerTime: null,
                lastPointerTime: null,
                basePointerClientY: null,
                lastPointerClientY: null,
                initialRowIndex,
                committedRowIndex: initialRowIndex,
                laneCandidateRowIndex: null,
                laneCandidateSinceMs: 0,
                laneIntentRowIndex: null,
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
                basePointerClientY: null,
                lastPointerClientY: null,
                initialRowIndex: 0,
                committedRowIndex: 0,
                laneCandidateRowIndex: null,
                laneCandidateSinceMs: 0,
                laneIntentRowIndex: null,
                initialStart: 0,
                initialEnd: 0,
                takeover: false,
              };
              detachGesturePointerTracking();
            }}
            onActionMoving={({ action, row, start, end }) => {
            const actionId = String((action as any)?.id ?? '');
            const g = gestureRef.current;

            const getRowIndexForRow = (r: CusTomTimelineRow) => {
              const id = String((r as unknown as { id?: unknown })?.id ?? '');
              if (!id) return -1;
              return dataRef.current.findIndex((x) => String((x as unknown as { id?: unknown })?.id ?? '') === id);
            };

            // If we are in takeover mode for this gesture, drive movement from pointer tracking.
            if (g.takeover && g.mode === 'move' && g.actionId === actionId) {
              const LANE_SWITCH_HOLD_MS = 160;
              const LANE_SWITCH_MIN_Y_PX = Math.max(10, ROW_HEIGHT_PX * 0.45);

              const base = g.basePointerTime;
              const last = g.lastPointerTime;
              const delta = base != null && last != null ? last - base : 0;
              const proposedStart = g.initialStart + delta;
              const proposedEnd = g.initialEnd + delta;
              const snapped = maybeSnapToCursorForMove(actionId, proposedStart, proposedEnd);
              const nextStart = snapped.start;
              const nextEnd = snapped.end;

              // Determine candidate lane based on pointer Y.
              const effectId = String((action as unknown as { effectId?: unknown })?.effectId ?? '');
              const kind: 'video' | 'audio' = effectId === 'effect1' ? 'video' : 'audio';

              const pointerY = g.lastPointerClientY;
              const rawRow = pointerY != null ? rowIndexFromClientY(pointerY) : null;
              const desiredLaneRow = normalizeRowIndexForKind(
                rawRow != null ? rawRow : g.committedRowIndex,
                kind
              );

              const baseY = g.basePointerClientY;
              const yDelta = baseY != null && pointerY != null ? Math.abs(pointerY - baseY) : 0;
              const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

              if (desiredLaneRow !== g.committedRowIndex && yDelta >= LANE_SWITCH_MIN_Y_PX) {
                if (g.laneCandidateRowIndex !== desiredLaneRow) {
                  g.laneCandidateRowIndex = desiredLaneRow;
                  g.laneCandidateSinceMs = now;
                }
                if (now - g.laneCandidateSinceMs >= LANE_SWITCH_HOLD_MS) {
                  g.laneIntentRowIndex = desiredLaneRow;
                }
              } else {
                g.laneCandidateRowIndex = null;
                g.laneCandidateSinceMs = 0;
                g.laneIntentRowIndex = null;
              }

              // Show ghost preview when the pointer is clearly in a different lane.
              const previewRow = desiredLaneRow !== g.committedRowIndex && yDelta >= LANE_SWITCH_MIN_Y_PX ? desiredLaneRow : null;
              if (previewRow != null) {
                setMoveGhostPreview({
                  actionId,
                  laneRow: previewRow,
                  start: nextStart,
                  end: nextEnd,
                  duration: Math.max(0.01, nextEnd - nextStart),
                  kind,
                });
              } else {
                setMoveGhostPreview(null);
              }

              // Overlap checks against the CURRENT committed lanes (we don't actually move lanes until drag end).
              const currentRows = dataRef.current;
              const mainRow = currentRows[g.committedRowIndex];
              if (mainRow && wouldOverlapInRow(mainRow, String(action.id), nextStart, nextEnd)) return false;

              const partner = findLinkedPartner(currentRows, String(action.id));
              if (partner) {
                const partnerTargetRowIndex = kind === 'video'
                  ? pairedAudioRowForVideoRow(normalizeRowIndexForKind(g.committedRowIndex, 'video'))
                  : pairedVideoRowForAudioRow(normalizeRowIndexForKind(g.committedRowIndex, 'audio'));
                const partnerRow = currentRows[partnerTargetRowIndex];
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
              const effectId = String((action as unknown as { effectId?: unknown })?.effectId ?? '');
              const typedRowIndex = getRowIndexForRow(typedRow);
              let partnerTargetRowIndex = partner.rowIndex;
              if (typedRowIndex >= 0) {
                if (effectId === 'effect1') {
                  const vRow = normalizeRowIndexForKind(typedRowIndex, 'video');
                  partnerTargetRowIndex = pairedAudioRowForVideoRow(vRow);
                } else {
                  const aRow = normalizeRowIndexForKind(typedRowIndex, 'audio');
                  partnerTargetRowIndex = pairedVideoRowForAudioRow(aRow);
                }
              }
              const partnerRow = currentRows[partnerTargetRowIndex];
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
                ...gestureRef.current,
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
                // Resizing doesn't change rows, so use the partner's current row.
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
                ...gestureRef.current,
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
              if (suppressNextTimelineOnChangeRef.current) {
                suppressNextTimelineOnChangeRef.current = false;
                return;
              }
              const nextClean = cleanEditorData(data as CusTomTimelineRow[]);
              const sourceActionId = pendingGestureActionIdRef.current;
              const nextLinked = sourceActionId ? applyLinkedStartEnd(nextClean, sourceActionId) : nextClean;
              const nextReconciled = reconcileLanePlacement(nextLinked, sourceActionId);
              setData(nextReconciled);

              // If this onChange is the result of a drag/resize gesture, record a single history entry.
              const pendingBefore = pendingHistoryBeforeRef.current;
              const pendingSig = pendingHistorySignatureRef.current;
              if (pendingBefore && pendingSig) {
                const nextSig = getTimelineSignature(nextReconciled);
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
export default MeliesVideoEditor;