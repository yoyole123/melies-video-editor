import { Timeline } from '@xzdarcy/react-timeline-editor';
import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CustomRender0, CustomRender1, CustomRender2 } from './custom';
import './index.less';
import { mockEffect, scale, scaleWidth } from './mock';
import type { CustomTimelineAction, CusTomTimelineRow } from './mock';
import type { FootageItem } from './footageBin';
import TimelinePlayer from './player';
import videoControl from './videoControl';
import mediaCache from './mediaCache';
import audioControl from './audioControl';
import { useCoarsePointer } from './useCoarsePointer';
import { APP_VERSION } from './appVersion';
import footageIconUrl from './assets/footage.png';
import importVideoIconUrl from './assets/import_video.png';
import zoomInIconUrl from './assets/zoom-in.png';
import zoomOutIconUrl from './assets/zoom-out.png';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
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

// Timeline times are stored in seconds as floating point numbers.
// Quantize to avoid tiny rounding gaps that can cause a visible black flash
// at clip boundaries (playback logic uses exclusive end).
const TIME_QUANTUM_SEC = 0.001; // 1ms
const MIN_ACTION_DURATION_SEC = 0.01;
const FALLBACK_CLIP_DURATION_SEC = 10;
const MICRO_GAP_MAX_SEC = 0.03; // collapse only very small gaps (rounding/precision), not intentional spacing

// Playback cheat tuning (mobile-first): pause, let decoding settle, seek, then resume.
// These are intentionally small so the UI still feels responsive.
const SEEK_PAUSE_BEFORE_MS = 70;
const SEEK_AFTER_MS = 70;
const SEEK_RESUME_BUFFER_AHEAD_SEC = 0.4;
const SEEK_RESUME_BUFFER_TIMEOUT_MS = 1400;
const SEEK_RESUME_BUFFER_POLL_MS = 100;
// While scrubbing/dragging, update preview at most ~4fps.
const SCRUB_SET_TIME_MIN_INTERVAL_MS = 500;

// Forward seeks often require more buffering than backward seeks.
// Apply a multiplier to the post-seek settle/buffer window when jumping into the future.
const FORWARD_SEEK_MULTIPLIER = 4;
const FORWARD_SEEK_EPSILON_SEC = 0.05;

// When the user releases a drag-scrub, we want noticeably more buffer before resuming.
const SEEK_AFTER_SCRUB_MS = 360;
const SEEK_RESUME_BUFFER_AHEAD_SCRUB_SEC = 0.9;
const SEEK_RESUME_BUFFER_TIMEOUT_SCRUB_MS = 3200;

/** Sleep helper for the seek cheat (kept tiny to avoid UI feeling stuck). */
const delayMs = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(() => resolve(), Math.max(0, ms));
  });

/**
 * Resolve clip duration in seconds.
 * Prefers real media metadata (video/audio duration) and falls back only when unavailable.
 */
const resolveClipDurationSec = async (item: {
  kind: 'video' | 'audio';
  src: string;
  defaultDuration?: number;
}): Promise<number> => {
  const fromMeta = await mediaCache.getDurationSec(item.src, item.kind);
  if (fromMeta != null && Number.isFinite(fromMeta) && fromMeta > 0) {
    return Math.max(MIN_ACTION_DURATION_SEC, fromMeta);
  }

  const fromDefault = Number(item.defaultDuration);
  if (Number.isFinite(fromDefault) && fromDefault > 0) {
    return Math.max(MIN_ACTION_DURATION_SEC, fromDefault);
  }

  return FALLBACK_CLIP_DURATION_SEC;
};

const quantizeTimeSec = (t: number) => {
  const n = Number(t);
  if (!Number.isFinite(n)) return 0;
  // Using multiply/divide avoids cumulative floating point drift from repeated +/- operations.
  return Math.round(n / TIME_QUANTUM_SEC) * TIME_QUANTUM_SEC;
};

const quantizeRangeSec = (start: number, end: number) => {
  const s = Math.max(0, quantizeTimeSec(start));
  const e = Math.max(0, quantizeTimeSec(end));
  if (e <= s) return { start: s, end: s + MIN_ACTION_DURATION_SEC };
  return { start: s, end: e };
};

const quantizeEditorData = (rows: CusTomTimelineRow[]): CusTomTimelineRow[] => {
  let changed = false;
  const next = rows.map((row) => {
    const actions = Array.isArray(row?.actions) ? row.actions : [];
    const nextActions = actions.map((action) => {
      const start = Number((action as unknown as { start?: unknown })?.start);
      const end = Number((action as unknown as { end?: unknown })?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return action;
      const q = quantizeRangeSec(start, end);
      if (q.start === start && q.end === end) return action;
      changed = true;
      return { ...action, start: q.start, end: q.end } as unknown as CustomTimelineAction;
    });
    return { ...row, actions: nextActions as unknown as CusTomTimelineRow['actions'] };
  });
  return changed ? next : rows;
};

const warnIfVideoGaps = (rows: CusTomTimelineRow[]) => {
  // Dev-only diagnostic: if there is an actual gap between adjacent video clips,
  // preview playback will go black there (exclusive end).
  try {
    const videoRowIndexes = [0, 1];
    for (const rowIndex of videoRowIndexes) {
      const row = rows[rowIndex];
      const actions = Array.isArray(row?.actions) ? row.actions : [];
      const vids = actions
        .filter((a) => String((a as unknown as { effectId?: unknown })?.effectId ?? '') === 'effect1')
        .map((a) => ({
          id: String((a as unknown as { id?: unknown })?.id ?? ''),
          start: Number((a as unknown as { start?: unknown })?.start),
          end: Number((a as unknown as { end?: unknown })?.end),
        }))
        .filter((a) => a.id && Number.isFinite(a.start) && Number.isFinite(a.end))
        .sort((a, b) => a.start - b.start);

      for (let i = 0; i < vids.length - 1; i++) {
        const cur = vids[i];
        const nxt = vids[i + 1];
        const gap = nxt.start - cur.end;
        if (gap > 0.001) {
          // eslint-disable-next-line no-console
          console.warn(
            `[timeline] gap on V${rowIndex + 1}: ${gap.toFixed(3)}s between ${cur.id} (end=${cur.end.toFixed(3)}) and ${nxt.id} (start=${nxt.start.toFixed(3)})`
          );
        }
      }
    }
  } catch {
    // ignore
  }
};

const FootageCard = ({
  item,
  hint,
  isDragging,
  listeners,
  attributes,
}: {
  item: FootageItem;
  hint?: string;
  isDragging: boolean;
  listeners?: any;
  attributes?: any;
}) => {
  return (
    <div
      className={`footage-card${isDragging ? ' is-dragging' : ''}`}
      title={hint}
      {...listeners}
      {...attributes}
    >
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
    </div>
  );
};

const DraggableFootageCard = ({ item }: { item: FootageItem }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `footage-${item.id}`,
    data: { item },
  });

  const style: React.CSSProperties | undefined = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : undefined;

  // We set the ref on the outer wrapper (for positioning), but attach listeners only to the inner card.
  // This leaves the "empty space" in the grid cell available for scrolling.
  return (
    <div ref={setNodeRef} style={style} className="draggable-footage-wrapper">
      <FootageCard
        item={item}
        isDragging={isDragging}
        listeners={listeners}
        attributes={attributes}
      />
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
   * Local Files to show in the footage bin.
   *
   * This is ideal for OPFS (Base44 can load from OPFS and pass `File`s here).
   */
  footageFiles?: File[];

  /**
   * Handle-like objects (e.g. `FileSystemFileHandle`) that can yield `File`s.
   *
   * We intentionally avoid depending on `FileSystemFileHandle` directly so
   * consumers without that DOM lib type can still compile.
   */
  footageFileHandles?: Array<{
    getFile: () => Promise<File>;
    name?: string;
  }>;

  /**
   * When true, automatically place `footageUrls` onto the timeline on first initialization
   * (one after another, starting at t=0).
   *
   * Defaults to false.
   */
  autoPlaceFootage?: boolean;

  /**
   * Optional initial timeline snapshot (e.g. loaded from your DB).
   *
   * Note: if you store `blob:` URLs in the snapshot, they will not be valid across sessions.
   * Prefer storing stable asset ids and rehydrating to playable URLs before loading.
   */
  initialTimelineSnapshot?: MeliesTimelineSnapshot;

  /**
   * Called whenever timeline state changes.
   *
   * Consumers should debounce/throttle this callback when persisting to a DB.
   */
  onTimelineStateChange?: (snapshot: MeliesTimelineSnapshot) => void;

  /**
   * Fired when the user imports files into the footage bin.
   *
   * This exposes the actual `File` objects to the host app (for upload/OPFS/storage).
   * Note: imported `blob:` URLs are session-only; hosts should persist and rehydrate using
   * stable asset identifiers if they need cross-session restore.
   */
  onFootageImported?: (event: MeliesFootageImportEvent) => void;
};

export type MeliesFootageImportEntry = {
  /** The bin item added to the footage bin. */
  item: FootageItem;
  /** The underlying file selected by the user. */
  file: File;
};

export type MeliesFootageImportEvent = {
  /** Pairs each created bin item to its underlying file. */
  entries: MeliesFootageImportEntry[];
  /** Convenience list of items. */
  items: FootageItem[];
  /** Convenience list of files. */
  files: File[];
};

export type MeliesTimelineSnapshot = {
  /** Bump this when snapshot schema changes. */
  version: 1;
  /** Timeline rows/actions data (seconds). */
  editorData: CusTomTimelineRow[];
  /** UI selection (optional to restore). */
  selectedActionId: string | null;
  /** UI zoom (optional to restore). */
  timelineScaleWidth: number;
};

export type MeliesVideoEditorRef = {
  /**
   * Get a deep-cloned snapshot of the current timeline state.
   * Safe to store/mutate externally.
   */
  getTimelineSnapshot: () => MeliesTimelineSnapshot;

  /**
   * Load a snapshot into the editor.
   * Resets undo/redo history.
   */
  setTimelineSnapshot: (snapshot: MeliesTimelineSnapshot) => void;

  /**
   * Get the imported `File` for a given footage item id (only for user-imported items).
   * Returns null if the id was not imported this session.
   */
  getImportedFileByFootageId: (footageId: string) => File | null;

  /** List all imported files currently known to the editor (this session). */
  listImportedFiles: () => Array<{ footageId: string; file: File }>;
};

const cloneSerializable = <T,>(value: T): T => {
  // Prefer structuredClone (fast + handles more types), but fall back to JSON for older runtimes.
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
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

const inferFootageKindFromFile = (file: File): FootageItem['kind'] => {
  const t = String(file?.type ?? '').toLowerCase();
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  return inferFootageKindFromUrl(file?.name ?? '');
};

const MeliesVideoEditor = forwardRef<MeliesVideoEditorRef, MeliesVideoEditorProps>(function MeliesVideoEditor(
  {
    footageUrls,
    footageFiles,
    footageFileHandles,
    autoPlaceFootage = false,
    initialTimelineSnapshot,
    onTimelineStateChange,
    onFootageImported,
  }: MeliesVideoEditorProps,
  ref
) {
  const [data, setData] = useState<CusTomTimelineRow[]>(() => createEmptyEditorData());
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [past, setPast] = useState<CusTomTimelineRow[][]>([]);
  const [future, setFuture] = useState<CusTomTimelineRow[][]>([]);
  const dataRef = useRef<CusTomTimelineRow[]>(data);

  // Sync data to VideoControl for lookahead/double-buffering
  useEffect(() => {
     videoControl.setEditorData(data);
  }, [data]);

  const isMobile = useCoarsePointer();
  const [isFootageBinOpen, setIsFootageBinOpen] = useState(false);
  const timelineState = useRef<TimelineState | null>(null);
  const playerPanel = useRef<HTMLDivElement | null>(null);
  const timelineWrapRef = useRef<HTMLDivElement | null>(null);
  const autoScrollWhenPlay = useRef<boolean>(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importedObjectUrlsRef = useRef<string[]>([]);
  const importedFilesByIdRef = useRef<Map<string, File>>(new Map());

  const urlFootageBin = useMemo<FootageItem[]>(() => {
    const urls = Array.isArray(footageUrls) ? footageUrls.filter(Boolean) : [];
    if (!urls.length) return [];
    return urls.map((src, index) => ({
      id: `url-${index}`,
      kind: inferFootageKindFromUrl(src),
      name: nameFromUrl(src, index),
      src,
    }));
  }, [footageUrls]);

  const [fileFootageBin, setFileFootageBin] = useState<FootageItem[]>([]);
  const [handleFootageBin, setHandleFootageBin] = useState<FootageItem[]>([]);
  const [importedFootageBin, setImportedFootageBin] = useState<FootageItem[]>([]);

  useEffect(() => {
    const files = Array.isArray(footageFiles) ? footageFiles.filter(Boolean) : [];
    if (files.length === 0) {
      setFileFootageBin([]);
      return;
    }

    const urlsToRevoke: string[] = [];
    const next: FootageItem[] = files.map((file, index) => {
      const url = URL.createObjectURL(file);
      urlsToRevoke.push(url);
      mediaCache.registerSrcMeta(url, { name: file.name, mimeType: file.type });
      return {
        id: `file-${index}`,
        kind: inferFootageKindFromFile(file),
        name: file.name || `Footage ${index + 1}`,
        src: url,
      };
    });

    setFileFootageBin(next);

    return () => {
      for (const url of urlsToRevoke) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    };
  }, [footageFiles]);

  useEffect(() => {
    const handles = Array.isArray(footageFileHandles) ? footageFileHandles.filter(Boolean) : [];
    if (handles.length === 0) {
      setHandleFootageBin([]);
      return;
    }

    let cancelled = false;
    const urlsToRevoke: string[] = [];

    const run = async () => {
      const next: FootageItem[] = [];
      for (let index = 0; index < handles.length; index++) {
        const handle = handles[index];
        try {
          const file = await handle.getFile();
          if (cancelled) return;
          const url = URL.createObjectURL(file);
          urlsToRevoke.push(url);
          mediaCache.registerSrcMeta(url, { name: file.name || handle?.name, mimeType: file.type });
          next.push({
            id: `handle-${index}`,
            kind: inferFootageKindFromFile(file),
            name: file.name || handle?.name || `Footage ${index + 1}`,
            src: url,
          });
        } catch (err) {
          console.warn('[MeliesVideoEditor] Failed to load file handle', err);
        }
      }
      if (cancelled) return;
      setHandleFootageBin(next);
    };

    void run();

    return () => {
      cancelled = true;
      for (const url of urlsToRevoke) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    };
  }, [footageFileHandles]);

  useEffect(() => {
    return () => {
      for (const url of importedObjectUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      importedObjectUrlsRef.current = [];
      importedFilesByIdRef.current.clear();
    };
  }, []);

  const footageBin = useMemo<FootageItem[]>(() => {
    return [...urlFootageBin, ...fileFootageBin, ...handleFootageBin, ...importedFootageBin];
  }, [urlFootageBin, fileFootageBin, handleFootageBin, importedFootageBin]);

  // Warm media duration metadata so drag previews and auto-place can use real lengths quickly.
  useEffect(() => {
    for (const item of footageBin) {
      void mediaCache.getDurationSec(item.src, item.kind);
    }
  }, [footageBin]);

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
  const timelinePointerDownRef = useRef<{ x: number; y: number; isAction: boolean } | null>(null);
  const cursorDraggingRef = useRef<{ pointerId: number } | null>(null);

  const ROW_HEIGHT_PX = isMobile ? 48 : 32;

  // Keep the Timeline's internal left gutter aligned with our lane-label column.
  // This ensures the 0 position starts immediately after the labels.
  const TIMELINE_LEFT_GUTTER_PX = 30;

  // Zoom: keep `scale` fixed (time per major tick) and adjust `scaleWidth` (px per tick).
  const [timelineScaleWidth, setTimelineScaleWidth] = useState(() => scaleWidth);
  const timelineScale = scale;

  /** Build a stable, serializable snapshot of the current editor state. */
  const getTimelineSnapshot = (): MeliesTimelineSnapshot => {
    const editorData = cloneSerializable(dataRef.current);
    return {
      version: 1,
      editorData,
      selectedActionId,
      timelineScaleWidth,
    };
  };

  /** Load a snapshot into the editor, resetting undo/redo history. */
  const setTimelineSnapshot = (snapshot: MeliesTimelineSnapshot) => {
    if (!snapshot || snapshot.version !== 1) {
      throw new Error('[MeliesVideoEditor] Unsupported snapshot version');
    }

    // Pause playback before applying state to avoid engine/scrub mismatch.
    try {
      if (timelineState.current?.isPlaying) timelineState.current.pause();
    } catch {
      // ignore
    }

    const nextRows = quantizeEditorData(cloneSerializable(snapshot.editorData ?? createEmptyEditorData()));
    const nextSelected = snapshot.selectedActionId ?? null;
    const nextScaleWidth = Number(snapshot.timelineScaleWidth);

    setSelectedActionId(nextSelected);
    setPast([]);
    setFuture([]);

    if (Number.isFinite(nextScaleWidth) && nextScaleWidth > 0) {
      setTimelineScaleWidth(Math.min(600, Math.max(60, Math.round(nextScaleWidth))));
    }

    setData(() => {
      dataRef.current = nextRows;
      return nextRows;
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      getTimelineSnapshot,
      setTimelineSnapshot,
      getImportedFileByFootageId: (footageId: string) => {
        return importedFilesByIdRef.current.get(String(footageId)) ?? null;
      },
      listImportedFiles: () => {
        return Array.from(importedFilesByIdRef.current.entries()).map(([footageId, file]) => ({
          footageId,
          file,
        }));
      },
    }),
    // Depend on view state that is included in snapshot.
    [selectedActionId, timelineScaleWidth]
  );

  // Optional "push" export for auto-save.
  useEffect(() => {
    if (!onTimelineStateChange) return;
    onTimelineStateChange(getTimelineSnapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedActionId, timelineScaleWidth, onTimelineStateChange]);

  // Optional "pull" import on mount / when the prop changes.
  const lastInitialSnapshotJsonRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialTimelineSnapshot) return;
    let json: string;
    try {
      json = JSON.stringify(initialTimelineSnapshot);
    } catch {
      // If it isn't serializable, avoid repeated crashes.
      return;
    }

    if (lastInitialSnapshotJsonRef.current === json) return;
    lastInitialSnapshotJsonRef.current = json;

    try {
      setTimelineSnapshot(initialTimelineSnapshot);
    } catch (err) {
      console.warn('[MeliesVideoEditor] Failed to apply initialTimelineSnapshot', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTimelineSnapshot]);

  const zoomByFactor = (factor: number) => {
    setTimelineScaleWidth((prev) => {
      const next = Math.round(prev * factor);
      return Math.min(600, Math.max(60, next));
    });
  };

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

    hasAutoPlacedFootageRef.current = true;

    let cancelled = false;

    const run = async () => {
      const next = createEmptyEditorData();
      let t = 0;

      for (const item of footageBin) {
        if (cancelled) return;
        const duration = await resolveClipDurationSec(item);
        const start = quantizeTimeSec(t);
        const end = quantizeTimeSec(t + duration);
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
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [autoPlaceFootage, footageBin]);

  // Preload media referenced by timeline actions to reduce buffering/stalls during playback.
  // This is intentionally fire-and-forget; cache dedupes across edits.
  useEffect(() => {
    mediaCache.warmFromEditorData(data);

    // Also warm up audio instances (Howler) and video buffers explicitly.
    // This allows immediate playback without waiting for initial decode on play.
    const audioSrcs = new Set<string>();
    const videoSrcs = new Set<string>();

    for (const row of data) {
      const actions = row.actions as CustomTimelineAction[];
      for (const action of actions) {
        if (action.effectId === 'effect0' || action.effectId === 'effect2') {
          const src = action.data?.src;
          if (src) audioSrcs.add(src);
        }
        if (action.effectId === 'effect1') {
          const d = action.data;
          const s = d?.previewSrc || d?.src;
          if (s) videoSrcs.add(s);
        }
      }
    }

    for (const src of audioSrcs) {
      audioControl.warm(src);
    }

    for (const src of videoSrcs) {
      videoControl.warm(src);
    }
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

  const trimGestureRef = useRef<{
    actionId: string | null;
    partnerId: string | null;
    dir: 'left' | 'right' | null;
    baseStart: number;
    baseOffset: number;
    partnerBaseOffset: number;
  }>({
    actionId: null,
    partnerId: null,
    dir: null,
    baseStart: 0,
    baseOffset: 0,
    partnerBaseOffset: 0,
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
    const q = quantizeRangeSec(nextStart, nextEnd);
    if (!Number.isFinite(q.start) || !Number.isFinite(q.end) || q.end <= q.start) return rows;

    const source = findActionById(rows, sourceActionId);
    if (!source) return rows;

    const partner = findLinkedPartner(rows, sourceActionId);

    // Fast path: if not linked, don't force state updates (let the library handle visuals).
    if (!partner) return rows;

    const next = structuredClone(rows) as CusTomTimelineRow[];

    const sourceRow = next[source.rowIndex];
    const sourceActions = Array.isArray(sourceRow.actions) ? [...sourceRow.actions] : [];
    const updatedSource: CustomTimelineAction = { ...(sourceActions[source.actionIndex] as any), start: q.start, end: q.end };
    sourceActions.splice(source.actionIndex, 1, updatedSource as any);
    sourceRow.actions = sourceActions as any;

    const partnerRow = next[partner.rowIndex];
    const partnerActions = Array.isArray(partnerRow.actions) ? [...partnerRow.actions] : [];
    const updatedPartner: CustomTimelineAction = { ...(partnerActions[partner.actionIndex] as any), start: q.start, end: q.end };
    partnerActions.splice(partner.actionIndex, 1, updatedPartner as any);
    partnerRow.actions = partnerActions as any;

    return next;
  };

  const setStartEndForActionOnly = (rows: CusTomTimelineRow[], sourceActionId: string, nextStart: number, nextEnd: number) => {
    const q = quantizeRangeSec(nextStart, nextEnd);
    if (!Number.isFinite(q.start) || !Number.isFinite(q.end) || q.end <= q.start) return rows;
    const source = findActionById(rows, sourceActionId);
    if (!source) return rows;
    const existingStart = Number(source.action.start);
    const existingEnd = Number(source.action.end);
    if (existingStart === q.start && existingEnd === q.end) return rows;

    const next = structuredClone(rows) as CusTomTimelineRow[];
    const sourceRow = next[source.rowIndex];
    const sourceActions = Array.isArray(sourceRow.actions) ? [...sourceRow.actions] : [];
    const updatedSource: CustomTimelineAction = { ...(sourceActions[source.actionIndex] as any), start: q.start, end: q.end };
    sourceActions.splice(source.actionIndex, 1, updatedSource as any);
    sourceRow.actions = sourceActions as any;
    return next;
  };

  const getCursorTime = () => {
    const t = timelineState.current?.getTime ? Number(timelineState.current.getTime()) : 0;
    return Number.isFinite(t) ? Math.max(0, t) : 0;
  };

  const getSnapPoints = (excludeActionId: string) => {
    const points: number[] = [getCursorTime()];
    const linked = excludeActionId ? findLinkedPartner(dataRef.current, excludeActionId) : null;
    const excludeIds = new Set([excludeActionId, linked?.action.id].filter(Boolean));

    for (const row of dataRef.current) {
      for (const action of row.actions) {
         if (excludeIds.has(String(action.id))) continue;
         const start = Number((action as any).start);
         const end = Number((action as any).end);
         if (Number.isFinite(start)) points.push(start);
         if (Number.isFinite(end)) points.push(end);
      }
    }
    return points;
  };

  const maybeSnapToCursorForMove = (actionId: string, nextStart: number, nextEnd: number) => {
    const duration = nextEnd - nextStart;
    if (!Number.isFinite(duration) || duration <= 0) {
      return { start: nextStart, end: nextEnd, snapped: false, edge: null as any };
    }

    const points = getSnapPoints(actionId);
    
    // Dynamic threshold based on zoom
    const pxPerSec = timelineScaleWidth / timelineScale;
    const snapThresholdSec = 20 / pxPerSec; 
    const snapReleaseSec = 40 / pxPerSec;

    let closestDistStart = Infinity;
    let closestPointStart = -1;
    let closestDistEnd = Infinity;
    let closestPointEnd = -1;

    for (const p of points) {
        const dS = Math.abs(nextStart - p);
        if (dS < closestDistStart) { closestDistStart = dS; closestPointStart = p; }
        const dE = Math.abs(nextEnd - p);
        if (dE < closestDistEnd) { closestDistEnd = dE; closestPointEnd = p; }
    }

    const closerEdge: 'start' | 'end' = closestDistStart <= closestDistEnd ? 'start' : 'end';
    const minDist = Math.min(closestDistStart, closestDistEnd);

    const snapState = snapStateRef.current;
    const isSameAction = snapState.actionId === actionId;
    const isSnapped = isSameAction && snapState.edge != null;

    if (minDist <= snapThresholdSec) {
      snapStateRef.current = { actionId, edge: closerEdge };
    } else if (isSnapped) {
      const edge = snapState.edge;
      const dist = edge === 'start' ? closestDistStart : closestDistEnd;
      if (dist > snapReleaseSec) {
        snapStateRef.current = { actionId, edge: null };
        return { start: nextStart, end: nextEnd, snapped: false, edge: null as any };
      }
    } else {
      return { start: nextStart, end: nextEnd, snapped: false, edge: null as any };
    }

    const edge = snapStateRef.current.edge as 'start' | 'end';
    if (edge === 'start') {
      const start = closestPointStart;
      const end = start + duration;
      return { start: Math.max(0, start), end: Math.max(Math.max(0, start), end), snapped: true, edge };
    }

    const end = closestPointEnd;
    const start = end - duration;
    return { start: Math.max(0, start), end: Math.max(0, end), snapped: true, edge };
  };

  const maybeSnapToCursorForResize = (actionId: string, nextStart: number, nextEnd: number, dir: 'left' | 'right') => {
    const points = getSnapPoints(actionId);

    const pxPerSec = timelineScaleWidth / timelineScale;
    const snapThresholdSec = 20 / pxPerSec; 
    const snapReleaseSec = 40 / pxPerSec;

    const snapEdge: 'start' | 'end' = dir === 'left' ? 'start' : 'end';
    
    let closestDist = Infinity;
    let closestPoint = -1;
    const checkVal = snapEdge === 'start' ? nextStart : nextEnd;

    for (const p of points) {
        const d = Math.abs(checkVal - p);
        if (d < closestDist) { closestDist = d; closestPoint = p; }
    }

    const snapState = snapStateRef.current;
    const isSameAction = snapState.actionId === actionId;
    const isSnapped = isSameAction && snapState.edge === snapEdge;

    if (closestDist <= snapThresholdSec) {
      snapStateRef.current = { actionId, edge: snapEdge };
    } else if (isSnapped) {
      if (closestDist > snapReleaseSec) {
        snapStateRef.current = { actionId, edge: null };
        return { start: nextStart, end: nextEnd, snapped: false };
      }
    } else {
      return { start: nextStart, end: nextEnd, snapped: false };
    }

    if (snapEdge === 'start') {
      const start = Math.max(0, closestPoint);
      const end = Math.max(start + 0.01, nextEnd);
      return { start, end, snapped: true };
    }

    const end = Math.max(0, closestPoint);
    const start = Math.min(nextStart, end - 0.01);
    return { start: Math.max(0, start), end: Math.max(0, end), snapped: true, edge: snapEdge };
  };

  const insertActionAtTime = async (
    item: { kind: 'video' | 'audio'; src: string; previewSrc?: string; name: string; defaultDuration?: number },
    at: number,
    targetRowIndex?: number | null
  ) => {
    const duration = await resolveClipDurationSec(item);
    let start = Math.max(0, quantizeTimeSec(at));
    let end = quantizeTimeSec(start + duration);

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
          start = quantizeTimeSec(other.end);
          end = quantizeTimeSec(start + duration);
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
            start: quantizeTimeSec(start),
            end: quantizeTimeSec(end),
            effectId: 'effect1',
            data: { src: item.src, previewSrc: item.previewSrc, name: item.name, linkId, videoLayer: layerForV },
          } as CustomTimelineAction,
        ];

        next[aRow].actions = [
          ...(next[aRow].actions ?? []),
          {
            id: audioId,
            start: quantizeTimeSec(start),
            end: quantizeTimeSec(end),
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
            start: quantizeTimeSec(start),
            end: quantizeTimeSec(end),
            effectId: 'effect0',
            data: { src: item.src, name: item.name },
          } as CustomTimelineAction,
        ];
      }

      const q = quantizeEditorData(next);
      if (import.meta.env.DEV) warnIfVideoGaps(q);
      return q;
    });
  };

  const getTimelineScrollLeft = () => {
    const root = timelineWrapRef.current;
    if (!root) return 0;
    const grid = root.querySelector('.timeline-editor-edit-area .ReactVirtualized__Grid') as HTMLElement | null;
    return grid?.scrollLeft ?? 0;
  };

  const getTimelineScrollTop = () => laneScrollTop;

  const timeFromClientX = (clientX: number) => {
    const root = timelineWrapRef.current;
    if (!root) return 0;
    const editArea = root.querySelector('.timeline-editor-edit-area') as HTMLElement | null;
    const rect = (editArea ?? root).getBoundingClientRect();
    const position = clientX - rect.x;
    const left = position + getTimelineScrollLeft();
    const time = ((left - TIMELINE_LEFT_GUTTER_PX) * timelineScale) / timelineScaleWidth;
    return Math.max(0, time);
  };

  const timeToPixel = (t: number) => {
    const time = Number(t);
    if (!Number.isFinite(time)) return 0;
    return TIMELINE_LEFT_GUTTER_PX + (time * timelineScaleWidth) / timelineScale;
  };

  const computeBumpedStart = (
    item: FootageItem,
    desiredStart: number,
    laneRowIndex: number,
    rows: CusTomTimelineRow[]
  ): number => {
    const duration = mediaCache.getCachedDurationSec(item.src) ?? item.defaultDuration ?? FALLBACK_CLIP_DURATION_SEC;
    let start = Math.max(0, quantizeTimeSec(desiredStart));
    let end = quantizeTimeSec(start + duration);

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
      start = quantizeTimeSec(other.end);
      end = quantizeTimeSec(start + duration);
    }

    return Math.max(0, quantizeTimeSec(start));
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

  const getActionOffsetSeconds = (action: CustomTimelineAction | null | undefined) => {
    const raw = Number((action as any)?.data?.offset ?? 0);
    return Number.isFinite(raw) ? raw : 0;
  };

  const setOffsetForActionOnly = (rows: CusTomTimelineRow[], actionId: string, nextOffset: number) => {
    const found = findActionById(rows, actionId);
    if (!found) return rows;
    const offset = Math.max(0, Number.isFinite(nextOffset) ? nextOffset : 0);
    const existing = getActionOffsetSeconds(found.action);
    if (existing === offset) return rows;

    const next = structuredClone(rows) as CusTomTimelineRow[];
    const row = next[found.rowIndex];
    const actions = Array.isArray(row.actions) ? [...row.actions] : [];
    const updated: CustomTimelineAction = {
      ...(actions[found.actionIndex] as any),
      data: { ...(((actions[found.actionIndex] as any)?.data ?? {}) as any), offset },
    };
    actions.splice(found.actionIndex, 1, updated as any);
    row.actions = actions as any;
    return next;
  };

  const setOffsetForActionAndLinked = (rows: CusTomTimelineRow[], actionId: string, nextOffset: number, nextPartnerOffset?: number) => {
    const found = findActionById(rows, actionId);
    if (!found) return rows;
    const partner = findLinkedPartner(rows, actionId);
    if (!partner) return setOffsetForActionOnly(rows, actionId, nextOffset);

    const offset = Math.max(0, Number.isFinite(nextOffset) ? nextOffset : 0);
    const partnerOffset = Math.max(0, Number.isFinite(Number(nextPartnerOffset)) ? Number(nextPartnerOffset) : offset);

    const next = structuredClone(rows) as CusTomTimelineRow[];

    const row = next[found.rowIndex];
    const actions = Array.isArray(row.actions) ? [...row.actions] : [];
    const updated: CustomTimelineAction = {
      ...(actions[found.actionIndex] as any),
      data: { ...(((actions[found.actionIndex] as any)?.data ?? {}) as any), offset },
    };
    actions.splice(found.actionIndex, 1, updated as any);
    row.actions = actions as any;

    const pRow = next[partner.rowIndex];
    const pActions = Array.isArray(pRow.actions) ? [...pRow.actions] : [];
    const pUpdated: CustomTimelineAction = {
      ...(pActions[partner.actionIndex] as any),
      data: { ...(((pActions[partner.actionIndex] as any)?.data ?? {}) as any), offset: partnerOffset },
    };
    pActions.splice(partner.actionIndex, 1, pUpdated as any);
    pRow.actions = pActions as any;

    return next;
  };

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
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // On touch, instant drag (with small movement threshold), so interactions feel responsive.
    // We rely on spacing in the bin for scrolling (users touch the empty space to scroll).
    useSensor(TouchSensor, { activationConstraint: { distance: 5 } })
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
      void insertActionAtTime(item, Math.max(0, dropTime), laneRowIndex);
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
    const duration =
      mediaCache.getCachedDurationSec(activeFootage.src) ?? activeFootage.defaultDuration ?? FALLBACK_CLIP_DURATION_SEC;
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
    // If a dnd-kit drag is active, let it own the gesture.
    if (activeFootage) return;

    /**
     * Pause playback while the user scrubs/drags the playhead.
     * This avoids repeated seeks while the engine is ticking (which can cause decoder stalls).
     */
    const beginScrubIfNeeded = () => {
      const state = timelineState.current;
      const wasPlaying = Boolean(state?.isPlaying);
      resumeAfterScrubRef.current = wasPlaying;
      if (wasPlaying) state?.pause?.();
    };

    // For mobile tap-to-seek (non-cursor hit), remember whether we were playing.
    // Some internal timeline interactions can pause playback before our pointer-up runs.
    if (isMobile && e.pointerType !== 'mouse') {
      wasPlayingOnPointerDownRef.current = Boolean(timelineState.current?.isPlaying);
    }

    // Cursor drag on mobile: the library's cursor drag is mouse-event oriented, so we shim it.
    const target = e.target as HTMLElement | null;
    const isCursorHit = Boolean(target?.closest?.('.timeline-editor-cursor-area, .timeline-editor-cursor'));
    if (isCursorHit) {
      beginScrubIfNeeded();
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

    // On desktop, don't override the library's mouse interactions beyond cursor drag.
    if (!isMobile) return;
    // Only treat touch/pen as mobile gesture; mouse keeps desktop behavior.
    if (e.pointerType === 'mouse') return;

    const isActionHit = Boolean(target?.closest?.('.timeline-editor-action, [data-action-id]'));
    timelinePointerDownRef.current = { x: e.clientX, y: e.clientY, isAction: isActionHit };
  };

  const handleTimelinePointerMove = (e: React.PointerEvent) => {
    if (activeFootage) return;

    const isTouchLike = isMobile && e.pointerType !== 'mouse';
    if (!isTouchLike) return;

    const throttleSetTime = (t: number) => {
      const now = performance.now();
      if (now - lastScrubSetAtRef.current >= SCRUB_SET_TIME_MIN_INTERVAL_MS) {
        lastScrubSetAtRef.current = now;
        timelineState.current?.setTime?.(t);
        return;
      }
      pendingScrubTimeRef.current = t;
      if (scrubFlushRafRef.current) return;
      scrubFlushRafRef.current = requestAnimationFrame(() => {
        scrubFlushRafRef.current = null;
        const next = pendingScrubTimeRef.current;
        pendingScrubTimeRef.current = null;
        if (next == null) return;
        lastScrubSetAtRef.current = performance.now();
        timelineState.current?.setTime?.(next);
      });
    };

    // A) Cursor drag (explicit hit-test)
    if (cursorDraggingRef.current && cursorDraggingRef.current.pointerId === e.pointerId) {
      throttleSetTime(timeFromClientX(e.clientX));
      e.preventDefault();
      return;
    }

    // B) Time-area scrubbing: user drags anywhere on the timeline and the library moves the playhead.
    // We treat horizontal drags as a scrub gesture.
    const start = timelinePointerDownRef.current;
    if (!start) return;
    if (start.isAction) return;

    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    const HORIZONTAL_SCRUB_START_PX = 8;
    const VERTICAL_SCRUB_CANCEL_PX = 14;

    if (!timeScrubbingRef.current) {
      if (dx < HORIZONTAL_SCRUB_START_PX) return;
      if (dy > VERTICAL_SCRUB_CANCEL_PX) return;

      // Promote to a scrub gesture.
      timeScrubbingRef.current = { pointerId: e.pointerId };
      // If we were playing at the start of the pointer gesture, pause now.
      if (wasPlayingOnPointerDownRef.current) {
        resumeAfterScrubRef.current = true;
        timelineState.current?.pause?.();
      }
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }

    if (timeScrubbingRef.current.pointerId !== e.pointerId) return;
    throttleSetTime(timeFromClientX(e.clientX));
    e.preventDefault();
  };

  const handleTimelinePointerUp = (e: React.PointerEvent) => {
    if (activeFootage) return;

    // End time-area scrubbing.
    if (timeScrubbingRef.current && timeScrubbingRef.current.pointerId === e.pointerId) {
      timeScrubbingRef.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      const t = timeFromClientX(e.clientX);
      const shouldResume = resumeAfterScrubRef.current || wasPlayingOnPointerDownRef.current;
      resumeAfterScrubRef.current = false;
      wasPlayingOnPointerDownRef.current = false;
      setTimeWithPlaybackCheat(t, {
        resume: shouldResume,
        afterSeekMs: SEEK_AFTER_SCRUB_MS,
        bufferAheadSec: SEEK_RESUME_BUFFER_AHEAD_SCRUB_SEC,
        bufferTimeoutMs: SEEK_RESUME_BUFFER_TIMEOUT_SCRUB_MS,
      });
      e.preventDefault();
      return;
    }

    // Finish cursor drag and don't treat it as a tap.
    if (cursorDraggingRef.current && cursorDraggingRef.current.pointerId === e.pointerId) {
      cursorDraggingRef.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      // Cursor-drag scrub end: apply delayed seek + buffer wait + resume.
      const t = timeFromClientX(e.clientX);
      const shouldResume = resumeAfterScrubRef.current;
      resumeAfterScrubRef.current = false;
      setTimeWithPlaybackCheat(t, {
        resume: shouldResume,
        afterSeekMs: SEEK_AFTER_SCRUB_MS,
        bufferAheadSec: SEEK_RESUME_BUFFER_AHEAD_SCRUB_SEC,
        bufferTimeoutMs: SEEK_RESUME_BUFFER_TIMEOUT_SCRUB_MS,
      });

      e.preventDefault();
      return;
    }

    // On desktop, don't override the library's mouse interactions.
    if (!isMobile) return;
    if (e.pointerType === 'mouse') return;

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
    setTimeWithPlaybackCheat(t, { resume: wasPlayingOnPointerDownRef.current });
    wasPlayingOnPointerDownRef.current = false;
  };

  const resumeAfterScrubRef = useRef(false);
  const lastScrubSetAtRef = useRef(0);
  const pendingScrubTimeRef = useRef<number | null>(null);
  const scrubFlushRafRef = useRef<number | null>(null);
  const seekJobIdRef = useRef(0);
  const wasPlayingOnPointerDownRef = useRef(false);
  const timeScrubbingRef = useRef<{ pointerId: number } | null>(null);
  const timeAreaPointerRef = useRef<{ pointerId: number } | null>(null);
  const skipNextTimeAreaClickRef = useRef(false);
  const pendingHeaderResumeRef = useRef(false);
  const headerPointerDownTimeRef = useRef<number | null>(null);
  const ignoreNextAfterSetTimeRef = useRef(false);
  const resumeJobIdRef = useRef(0);

  /**
   * Capture-phase pointer down handler to remember whether playback was active.
   * This runs even if the Timeline component stops propagation for certain regions
   * (notably the top timecode/header bar).
   */
  const handleTimelinePointerDownCapture = () => {
    wasPlayingOnPointerDownRef.current = Boolean(timelineState.current?.isPlaying);
  };

  useEffect(() => {
    const handlePointerDownCapture = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const isTimeArea = Boolean(
        target.closest?.('.timeline-editor-time-area-interact, .timeline-editor-time-area, .timeline-editor-time')
      );
      const isInsideTimeline = Boolean(timelineWrapRef.current?.contains(target));

      if (!isTimeArea && !isInsideTimeline) return;

      const wasPlaying = Boolean(timelineState.current?.isPlaying);
      wasPlayingOnPointerDownRef.current = wasPlaying;

      if (isTimeArea && wasPlaying) {
        pendingHeaderResumeRef.current = true;
        headerPointerDownTimeRef.current = Number(timelineState.current?.getTime?.());
      }

      if (isMobile && event.pointerType !== 'mouse' && isTimeArea && Number.isFinite(event.pointerId)) {
        timeAreaPointerRef.current = { pointerId: event.pointerId };
      }
    };

    const handlePointerUpCapture = (event: PointerEvent) => {
      if (!isMobile || event.pointerType === 'mouse') return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const activePointer = timeAreaPointerRef.current;
      if (!activePointer || activePointer.pointerId !== event.pointerId) return;

      const isTimeArea = Boolean(
        target.closest?.('.timeline-editor-time-area-interact, .timeline-editor-time-area, .timeline-editor-time')
      );
      if (!isTimeArea) {
        timeAreaPointerRef.current = null;
        return;
      }

      // Manually compute time and apply seek+resume, since the Timeline component
      // does not consistently resume playback for time-area taps on mobile.
      const t = timeFromClientX(event.clientX);
      setTimeWithPlaybackCheat(t, { resume: wasPlayingOnPointerDownRef.current });
      wasPlayingOnPointerDownRef.current = false;

      // Prevent double-handling if onClickTimeArea fires later.
      skipNextTimeAreaClickRef.current = true;
      timeAreaPointerRef.current = null;
    };

    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    document.addEventListener('pointerup', handlePointerUpCapture, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
      document.removeEventListener('pointerup', handlePointerUpCapture, true);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    const attach = () => {
      if (disposed) return;
      const engine = timelineState.current as unknown as TimelineState | null;
      if (!engine?.listener) {
        requestAnimationFrame(attach);
        return;
      }

      const onAfterSetTime = () => {
        if (ignoreNextAfterSetTimeRef.current) {
          ignoreNextAfterSetTimeRef.current = false;
          return;
        }

        if (!pendingHeaderResumeRef.current) return;
        pendingHeaderResumeRef.current = false;

        const beforeRaw = headerPointerDownTimeRef.current;
        headerPointerDownTimeRef.current = null;
        const after = Number(timelineState.current?.getTime?.());
        const isForwardSeek =
          beforeRaw != null &&
          Number.isFinite(beforeRaw) &&
          Number.isFinite(after) &&
          after > beforeRaw + FORWARD_SEEK_EPSILON_SEC;
        const forwardMultiplier = isForwardSeek ? FORWARD_SEEK_MULTIPLIER : 1;
        const pauseBeforeMs = SEEK_PAUSE_BEFORE_MS;
        const afterSeekMs = SEEK_AFTER_MS * forwardMultiplier;
        const bufferAheadSec = SEEK_RESUME_BUFFER_AHEAD_SEC * (forwardMultiplier > 1 ? 1.25 : 1);
        const bufferTimeoutMs = SEEK_RESUME_BUFFER_TIMEOUT_MS * forwardMultiplier;

        const myJobId = ++resumeJobIdRef.current;
        const run = async () => {
          const state = timelineState.current;
          if (!state) return;

          state.pause?.();
          await delayMs(pauseBeforeMs);
          if (resumeJobIdRef.current !== myJobId) return;
          await delayMs(afterSeekMs);
          if (resumeJobIdRef.current !== myJobId) return;

          await videoControl.waitForActiveBufferedAhead({
            minSecondsAhead: bufferAheadSec,
            timeoutMs: bufferTimeoutMs,
            pollMs: SEEK_RESUME_BUFFER_POLL_MS,
          });

          if (resumeJobIdRef.current !== myJobId) return;
          try {
            audioControl.unlock();
          } catch {
            // ignore
          }
          state.play?.({ autoEnd: true });
        };

        void run();
      };

      engine.listener.on('afterSetTime', onAfterSetTime);
      cleanup = () => engine.listener.off('afterSetTime', onAfterSetTime);
    };

    attach();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  /**
   * Sets the playhead time. If currently playing, temporarily pauses and resumes.
   * This reduces seek-related stutter on larger files.
   */
  const setTimeWithPlaybackCheat = (
    t: number,
    opts?: {
      /** Force resume even if the engine is currently paused. */
      resume?: boolean;
      pauseBeforeMs?: number;
      afterSeekMs?: number;
      bufferAheadSec?: number;
      bufferTimeoutMs?: number;
      /** If false, disables forward-seek boosting. */
      enableForwardBoost?: boolean;
    }
  ) => {
    const state = timelineState.current;
    if (!state?.setTime) return;
    const nextTime = Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;

    // Cancel/override any in-flight seek job and only keep the newest.
    const myJobId = ++seekJobIdRef.current;

    const shouldResume = Boolean(opts?.resume) || Boolean(state.isPlaying);

    const currentTime = Number(state.getTime?.());
    const isForwardSeek =
      Number.isFinite(currentTime) && nextTime > currentTime + FORWARD_SEEK_EPSILON_SEC;
    const forwardMultiplier =
      (opts?.enableForwardBoost ?? true) && shouldResume && isForwardSeek ? FORWARD_SEEK_MULTIPLIER : 1;

    const pauseBeforeMs = Math.max(0, Number(opts?.pauseBeforeMs ?? SEEK_PAUSE_BEFORE_MS));
    const afterSeekMs =
      Math.max(0, Number(opts?.afterSeekMs ?? SEEK_AFTER_MS)) * forwardMultiplier;
    const bufferAheadSec =
      Math.max(0, Number(opts?.bufferAheadSec ?? SEEK_RESUME_BUFFER_AHEAD_SEC)) *
      (forwardMultiplier > 1 ? 1.25 : 1);
    const bufferTimeoutMs =
      Math.max(0, Number(opts?.bufferTimeoutMs ?? SEEK_RESUME_BUFFER_TIMEOUT_MS)) * forwardMultiplier;

    const run = async () => {
      if (shouldResume) state.pause?.();
      await delayMs(pauseBeforeMs);
      if (seekJobIdRef.current !== myJobId) return;

      ignoreNextAfterSetTimeRef.current = true;
      state.setTime(nextTime);
      // Some timeline implementations benefit from an explicit reRender to show the frame.
      state.reRender?.();

      await delayMs(afterSeekMs);
      if (seekJobIdRef.current !== myJobId) return;

      if (!shouldResume) return;

      // Try to resume only once the active video has buffered a bit.
      await videoControl.waitForActiveBufferedAhead({
        minSecondsAhead: bufferAheadSec,
        timeoutMs: bufferTimeoutMs,
        pollMs: SEEK_RESUME_BUFFER_POLL_MS,
      });

      if (seekJobIdRef.current !== myJobId) return;

      try {
        audioControl.unlock();
      } catch {
        // ignore
      }
      state.play?.({ autoEnd: true });
    };

    void run();
  };

  const handleImportedFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter(Boolean);
    if (files.length === 0) return;

    const items: FootageItem[] = [];
    const entries: MeliesFootageImportEntry[] = [];
    const urls: string[] = [];

    for (const file of files) {
      try {
        const url = URL.createObjectURL(file);
        urls.push(url);
        mediaCache.registerSrcMeta(url, { name: file.name, mimeType: file.type });
        const item: FootageItem = {
          id: `import-${uid()}`,
          kind: inferFootageKindFromFile(file),
          name: file.name || 'Imported footage',
          src: url,
        };
        importedFilesByIdRef.current.set(item.id, file);
        items.push(item);
        entries.push({ item, file });
      } catch {
        // ignore
      }
    }

    if (!items.length) return;

    importedObjectUrlsRef.current.push(...urls);
    setImportedFootageBin((prev) => [...prev, ...items]);

    try {
      onFootageImported?.({ entries, items, files: entries.map((e) => e.file) });
    } catch (err) {
      console.warn('[MeliesVideoEditor] onFootageImported threw', err);
    }
  };

  const [isVersionTooltipOpen, setIsVersionTooltipOpen] = useState(false);
  const versionDebugRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isVersionTooltipOpen) return;

    /**
     * Close the version tooltip on outside click / Escape.
     * This is intentionally small + dev-only UX.
     */
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsVersionTooltipOpen(false);
      }
    };

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const targetNode = e.target as Node | null;
      if (!targetNode) return;
      const root = versionDebugRef.current;
      if (!root) return;
      if (root.contains(targetNode)) return;
      setIsVersionTooltipOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('touchstart', handlePointerDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('touchstart', handlePointerDown, true);
    };
  }, [isVersionTooltipOpen]);

  return (
    <DndContext
      sensors={sensors}
      autoScroll
      collisionDetection={rectIntersection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="timeline-editor-engine">
        <div className="player-stack">
          <div className="footage-ribbon" role="toolbar" aria-label="Footage">
            <div className="footage-ribbon-left">
              <div className="footage-toggle-stack">
                <button
                  type="button"
                  className={`footage-ribbon-toggle${isFootageBinOpen ? ' is-open' : ''}`}
                  aria-expanded={isFootageBinOpen}
                  aria-controls="footage-bin-panel"
                  onClick={() => setIsFootageBinOpen((v) => !v)}
                >
                  <img src={footageIconUrl} alt="Footage" draggable={false} />
                </button>

                <button
                  type="button"
                  className={`footage-edge-handle${isFootageBinOpen ? ' is-open' : ''}`}
                  aria-label={isFootageBinOpen ? 'Close footage bin' : 'Open footage bin'}
                  aria-expanded={isFootageBinOpen}
                  aria-controls="footage-bin-panel"
                  onClick={() => setIsFootageBinOpen((v) => !v)}
                >
                  {/* <span className="footage-edge-puller" aria-hidden="true" /> */}
                  <span className="footage-edge-chevron" aria-hidden="true" />
                </button>
              </div>

              <div className="footage-ribbon-title">Footage</div>
              <div
                className={`footage-ribbon-hint${isFootageBinOpen ? ' is-visible' : ''}`}
                aria-hidden={!isFootageBinOpen}
              >
                {isMobile ? 'Drag clips to timeline' : 'Drag clips to timeline'}
              </div>
            </div>

            <div className="footage-ribbon-right">
              <div
                className={`footage-import-container${isFootageBinOpen ? ' is-visible' : ''}`}
                aria-hidden={!isFootageBinOpen}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,audio/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    handleImportedFiles(e.target.files);
                    if (e.target) {
                      e.target.value = '';
                    }
                  }}
                />
                <button
                  type="button"
                  className="footage-import-button"
                  onClick={() => {
                    if (!isFootageBinOpen) return;
                    fileInputRef.current?.click();
                  }}
                  aria-label="Import footage"
                  title="Import footage"
                >
                  <img src={importVideoIconUrl} alt="" draggable={false} />
                </button>
              </div>

              <div ref={versionDebugRef} className="debug-version">
                <button
                  type="button"
                  className="debug-version-button"
                  aria-label={isVersionTooltipOpen ? 'Hide version' : 'Show version'}
                  aria-expanded={isVersionTooltipOpen}
                  onClick={() => setIsVersionTooltipOpen((v) => !v)}
                  title="Version"
                >
                  <span aria-hidden="true">i</span>
                </button>
                {isVersionTooltipOpen ? (
                  <div className="debug-version-tooltip" role="tooltip">
                    v{APP_VERSION}
                  </div>
                ) : null}
              </div>
            </div>
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
                />
              ))}
            </div>
          </div>

          <div className="player-panel" ref={playerPanel}>
            {/* Dual video elements for seamless playback (Double Buffering) */}
            <video
              className="player-video player-video-primary"
              preload="auto"
              playsInline
              muted
              controls={false}
              disablePictureInPicture
              disableRemotePlayback
              controlsList="nodownload noplaybackrate noremoteplayback"
              tabIndex={-1}
              onContextMenu={(e) => e.preventDefault()}
              ref={(el) => videoControl.attachPrimary(el)}
            />
            <video
              className="player-video player-video-secondary"
              preload="auto" // Preload next clip
              playsInline
              muted
              controls={false}
              disablePictureInPicture
              disableRemotePlayback
              controlsList="nodownload noplaybackrate noremoteplayback"
              tabIndex={-1}
              onContextMenu={(e) => e.preventDefault()}
              ref={(el) => videoControl.attachSecondary(el)}
            />
          </div>
        </div>
        <TimelinePlayer
          timelineState={timelineState}
          autoScrollWhenPlay={autoScrollWhenPlay}
          scale={timelineScale}
          scaleWidth={timelineScaleWidth}
          startLeft={TIMELINE_LEFT_GUTTER_PX}
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
          onPointerDownCapture={handleTimelinePointerDownCapture}
          onPointerDown={handleTimelinePointerDown}
          onPointerMove={handleTimelinePointerMove}
          onPointerUp={handleTimelinePointerUp}
          onPointerCancel={handleTimelinePointerUp}
        >
          <div className="timeline-zoom-controls" aria-label="Timeline zoom">
            <button
              type="button"
              className="timeline-zoom-control"
              onClick={() => zoomByFactor(1 / 1.25)}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <img src={zoomOutIconUrl} alt="" draggable={false} />
            </button>
            <button
              type="button"
              className="timeline-zoom-control"
              onClick={() => zoomByFactor(1.25)}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <img src={zoomInIconUrl} alt="" draggable={false} />
            </button>
          </div>

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
                const pxPerSec = timelineScaleWidth / timelineScale;
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
                const pxPerSec = timelineScaleWidth / timelineScale;
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

          <Timeline
            scale={timelineScale}
            scaleWidth={timelineScaleWidth}
            startLeft={TIMELINE_LEFT_GUTTER_PX}
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
            onClickTimeArea={(time, _e) => {
              setSelectedActionId(null);
              if (skipNextTimeAreaClickRef.current) {
                skipNextTimeAreaClickRef.current = false;
                return undefined;
              }
              // Click-to-seek (including top timecode/header bar): avoid seeking while engine is ticking.
              // Force resume if we were playing at pointer-down (mobile or desktop).
              setTimeWithPlaybackCheat(Number(time), {
                resume: wasPlayingOnPointerDownRef.current || Boolean(timelineState.current?.isPlaying),
              });
              wasPlayingOnPointerDownRef.current = false;
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

              // Capture base in-point offsets so left-trim adjusts media start time.
              const baseOffset = getActionOffsetSeconds(found?.action ?? (action as any));
              const partner = actionId ? findLinkedPartner(dataRef.current, actionId) : null;
              const partnerId = partner ? String(partner.action.id) : null;
              const partnerBaseOffset = partner ? getActionOffsetSeconds(partner.action) : baseOffset;
              trimGestureRef.current = {
                actionId,
                partnerId,
                dir: null,
                baseStart: Number.isFinite(start) ? start : 0,
                baseOffset,
                partnerBaseOffset,
              };

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

              trimGestureRef.current = {
                actionId: null,
                partnerId: null,
                dir: null,
                baseStart: 0,
                baseOffset: 0,
                partnerBaseOffset: 0,
              };
            }}
            onActionMoving={({ action, row, start, end }) => {
            const actionId = String((action as any)?.id ?? '');
            const g = gestureRef.current;

            const clampMoveRangeToZero = (rangeStart: number, rangeEnd: number) => {
              const s = Number(rangeStart);
              const e = Number(rangeEnd);
              if (!Number.isFinite(s) || !Number.isFinite(e)) return { start: rangeStart, end: rangeEnd, clamped: false };
              if (e <= s) return { start: rangeStart, end: rangeEnd, clamped: false };
              if (s >= 0) return { start: s, end: e, clamped: false };
              const shift = -s;
              return { start: 0, end: e + shift, clamped: true };
            };

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
              const clamped = clampMoveRangeToZero(snapped.start, snapped.end);
              const nextStart = clamped.start;
              const nextEnd = clamped.end;

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
            const clamped = clampMoveRangeToZero(snapped.start, snapped.end);
            const nextStart = clamped.start;
            const nextEnd = clamped.end;
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
            if (partner || snapped.snapped || clamped.clamped) {
              setData((prev) => {
                const updated = partner
                  ? setStartEndForActionAndLinked(prev, String(action.id), nextStart, nextEnd)
                  : setStartEndForActionOnly(prev, String(action.id), nextStart, nextEnd);
                dataRef.current = updated;
                return updated;
              });
            }

            // IMPORTANT: when snapped or clamped, prevent the timeline lib from applying its own drag position.
            // This makes the actively-dragged clip stick visually to the cursor magnet / clamp.
            if (snapped.snapped || clamped.clamped) {
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
            // Remember last resize direction so onChange can apply correct trim behavior.
            if (g.actionId === actionId && g.mode === 'resize') {
              g.dir = resizeDir;
            }
            if (trimGestureRef.current.actionId === actionId) {
              trimGestureRef.current.dir = resizeDir;
            }

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
                let updated = partner
                  ? setStartEndForActionAndLinked(prev, String(action.id), nextStart, nextEnd)
                  : setStartEndForActionOnly(prev, String(action.id), nextStart, nextEnd);

                // Left-trim: advance media offset by the same delta as start time.
                if (resizeDir === 'left' && trimGestureRef.current.actionId === String(action.id)) {
                  const deltaStart = nextStart - trimGestureRef.current.baseStart;
                  const nextOffset = trimGestureRef.current.baseOffset + (Number.isFinite(deltaStart) ? deltaStart : 0);
                  const nextPartnerOffset = trimGestureRef.current.partnerBaseOffset + (Number.isFinite(deltaStart) ? deltaStart : 0);
                  updated = partner
                    ? setOffsetForActionAndLinked(updated, String(action.id), nextOffset, nextPartnerOffset)
                    : setOffsetForActionOnly(updated, String(action.id), nextOffset);
                }
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
              let nextLinked = sourceActionId ? applyLinkedStartEnd(nextClean, sourceActionId) : nextClean;

              // Trim behavior: when resizing from the left, shift the media in-point (data.offset)
              // by the same amount as the clip's start time moved.
              if (sourceActionId && trimGestureRef.current.actionId === sourceActionId && trimGestureRef.current.dir === 'left') {
                const found = findActionById(nextLinked, sourceActionId);
                if (found) {
                  const nextStart = Number((found.action as any)?.start);
                  const deltaStart = nextStart - trimGestureRef.current.baseStart;
                  const nextOffset = trimGestureRef.current.baseOffset + (Number.isFinite(deltaStart) ? deltaStart : 0);
                  const nextPartnerOffset = trimGestureRef.current.partnerBaseOffset + (Number.isFinite(deltaStart) ? deltaStart : 0);

                  const partnerId = trimGestureRef.current.partnerId;
                  const hasPartner = Boolean(partnerId);
                  nextLinked = hasPartner
                    ? setOffsetForActionAndLinked(nextLinked, sourceActionId, nextOffset, nextPartnerOffset)
                    : setOffsetForActionOnly(nextLinked, sourceActionId, nextOffset);
                }
              }

              const nextReconciled = reconcileLanePlacement(nextLinked, sourceActionId);

              // Normalize times to avoid tiny rounding gaps, and collapse micro-gaps that are
              // almost certainly accidental (precision drift). Larger gaps are preserved.
              let normalized = quantizeEditorData(nextReconciled);
              for (const vRowIndex of VIDEO_ROW_INDEXES) {
                const row = normalized[vRowIndex];
                const actions = Array.isArray(row?.actions) ? row.actions : [];
                const vids = actions
                  .filter((a) => String((a as unknown as { effectId?: unknown })?.effectId ?? '') === 'effect1')
                  .map((a) => ({
                    id: String((a as unknown as { id?: unknown })?.id ?? ''),
                    start: Number((a as unknown as { start?: unknown })?.start),
                    end: Number((a as unknown as { end?: unknown })?.end),
                  }))
                  .filter((a) => a.id && Number.isFinite(a.start) && Number.isFinite(a.end))
                  .sort((a, b) => a.start - b.start);

                for (let i = 0; i < vids.length - 1; i++) {
                  const cur = vids[i];
                  const nxt = vids[i + 1];
                  const gap = nxt.start - cur.end;
                  if (gap > 0 && gap <= MICRO_GAP_MAX_SEC) {
                    const dur = nxt.end - nxt.start;
                    const ns = quantizeTimeSec(cur.end);
                    const ne = quantizeTimeSec(ns + dur);
                    const partner = findLinkedPartner(normalized, nxt.id);
                    normalized = partner
                      ? setStartEndForActionAndLinked(normalized, nxt.id, ns, ne)
                      : setStartEndForActionOnly(normalized, nxt.id, ns, ne);
                  }
                }
              }
              normalized = quantizeEditorData(normalized);
              if (import.meta.env.DEV) warnIfVideoGaps(normalized);
              setData(normalized);

              // If this onChange is the result of a drag/resize gesture, record a single history entry.
              const pendingBefore = pendingHistoryBeforeRef.current;
              const pendingSig = pendingHistorySignatureRef.current;
              if (pendingBefore && pendingSig) {
                const nextSig = getTimelineSignature(normalized);
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
});
export default MeliesVideoEditor;