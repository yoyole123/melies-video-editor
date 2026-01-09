import type { TimelineAction, TimelineEffect, TimelineRow } from '@xzdarcy/react-timeline-editor';
import audioControl from './audioControl';
import videoControl from './videoControl';

export const scaleWidth = 160;
export const scale = 5;
export const startLeft = 20;

export interface CustomTimelineAction extends TimelineAction {
  data: {
    src: string;
    previewSrc?: string;
    name: string;
    /** Video lane index (0=V1, 1=V2). Higher value wins when overlapping. */
    videoLayer?: number;
    /** Shared id for clips that should move/trim together (e.g. video + its embedded audio). */
    linkId?: string;
    /**
     * In-point offset into the underlying media (seconds).
     * Used for split clips so the right segment continues from the correct time.
     */
    offset?: number;
  };
}

export interface CusTomTimelineRow extends TimelineRow {
  actions: CustomTimelineAction[];
}

export const mockEffect: Record<string, TimelineEffect> = {
  effect0: {
    id: 'effect0',
    name: 'Play audio',
    source: {
      start: ({ action, engine, isPlaying, time }) => {
        if (isPlaying) {
          const { src, previewSrc, offset } = (action as CustomTimelineAction).data;
          const chosen = previewSrc || src;
          audioControl.warm(chosen);
          audioControl.start({ actionId: action.id, src: chosen, startTime: action.start, engine, time, offset });
        }
      },
      enter: ({ action, engine, isPlaying, time }) => {
        if (isPlaying) {
          const { src, previewSrc, offset } = (action as CustomTimelineAction).data;
          const chosen = previewSrc || src;
          audioControl.warm(chosen);
          audioControl.start({ actionId: action.id, src: chosen, startTime: action.start, engine, time, offset });
        }
      },
      leave: ({ action }) => {
        audioControl.stop({ actionId: action.id });
      },
      stop: ({ action }) => {
        audioControl.stop({ actionId: action.id });
      },
    },
  },
  effect2: {
    id: 'effect2',
    name: 'Play video audio',
    source: {
      start: ({ action, engine, isPlaying, time }) => {
        if (isPlaying) {
          const { src, previewSrc, offset } = (action as CustomTimelineAction).data;
          const chosen = previewSrc || src;
          audioControl.warm(chosen);
          audioControl.start({ actionId: action.id, src: chosen, startTime: action.start, engine, time, offset });
        }
      },
      enter: ({ action, engine, isPlaying, time }) => {
        if (isPlaying) {
          const { src, previewSrc, offset } = (action as CustomTimelineAction).data;
          const chosen = previewSrc || src;
          audioControl.warm(chosen);
          audioControl.start({ actionId: action.id, src: chosen, startTime: action.start, engine, time, offset });
        }
      },
      leave: ({ action }) => {
        audioControl.stop({ actionId: action.id });
      },
      stop: ({ action }) => {
        audioControl.stop({ actionId: action.id });
      },
    },
  },
  effect1: {
    id: 'effect1',
    name: 'Play video',
    source: {
      start: ({ action, engine, isPlaying, time }) => {
        const { src, previewSrc, offset, videoLayer } = (action as CustomTimelineAction).data ?? ({} as any);
        const chosen = previewSrc || src;
        if (chosen) videoControl.warm(chosen);
        videoControl.claimVideo({
          actionId: String(action.id),
          layer: Number.isFinite(Number(videoLayer)) ? Number(videoLayer) : 0,
          src: chosen,
          engine,
          isPlaying,
          time,
          actionStart: Number(action.start),
          offset,
        });
      },
      enter: ({ action, engine, isPlaying, time }) => {
        const { src, previewSrc, offset, videoLayer } = (action as CustomTimelineAction).data ?? ({} as any);
        const chosen = previewSrc || src;
        if (chosen) videoControl.warm(chosen);
        videoControl.claimVideo({
          actionId: String(action.id),
          layer: Number.isFinite(Number(videoLayer)) ? Number(videoLayer) : 0,
          src: chosen,
          engine,
          isPlaying,
          time,
          actionStart: Number(action.start),
          offset,
        });
      },
      update: ({ action, engine, time, isPlaying }) => {
        const { src, previewSrc, offset, videoLayer } = (action as CustomTimelineAction).data ?? ({} as any);
        const chosen = previewSrc || src;
        videoControl.claimVideo({
          actionId: String(action.id),
          layer: Number.isFinite(Number(videoLayer)) ? Number(videoLayer) : 0,
          src: chosen,
          engine,
          isPlaying,
          time,
          actionStart: Number(action.start),
          offset,
        });
      },
      leave: ({ action }) => {
        videoControl.releaseVideo(String(action.id));
      },
      stop: ({ action }) => {
        videoControl.releaseVideo(String(action.id));
      },
    },
  },
};

export const mockData: CusTomTimelineRow[] = [
  {
    id: '0',
    actions: [
      {
        id: 'action0',
        start: 0,
        end: 10,
        effectId: 'effect1',
        data: {
          src: '/footage/Big_Buck_Bunny_720_10s_5MB.mp4',
          name: 'Big Buck Bunny (10s)',
        },
      },
    ],
  },
  {
    id: '1',
    actions: [],
  },
  {
    id: '2',
    actions: [
      {
        id: 'action1',
        start: 0,
        end: 10,
        effectId: 'effect0',
        data: {
          src: '/footage/file_example_MP3_700KB.mp3',
          name: 'Example MP3 (looped)',
        },
      },
    ],
  },
  {
    id: '3',
    actions: [],
  },
];