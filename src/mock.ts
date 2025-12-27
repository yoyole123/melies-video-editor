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
          const { src, offset } = (action as CustomTimelineAction).data;
          audioControl.warm(src);
          audioControl.start({ actionId: action.id, src, startTime: action.start, engine, time, offset });
        }
      },
      enter: ({ action, engine, isPlaying, time }) => {
        if (isPlaying) {
          const { src, offset } = (action as CustomTimelineAction).data;
          audioControl.warm(src);
          audioControl.start({ actionId: action.id, src, startTime: action.start, engine, time, offset });
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
        const { src, previewSrc, offset } = (action as CustomTimelineAction).data ?? ({} as any);
        const chosen = previewSrc || src;
        if (chosen) {
          videoControl.warm(chosen);
          videoControl.setSource(chosen);
        }
        videoControl.setActive(true);
        videoControl.setRate(engine.getPlayRate());
        const inPoint = Number(offset ?? 0);
        videoControl.seek(Math.max(0, time - action.start + (Number.isFinite(inPoint) ? inPoint : 0)), { force: true });
        if (isPlaying) {
          videoControl.play();
        }
      },
      enter: ({ action, engine, isPlaying, time }) => {
        const { src, previewSrc, offset } = (action as CustomTimelineAction).data ?? ({} as any);
        const chosen = previewSrc || src;
        if (chosen) {
          videoControl.warm(chosen);
          videoControl.setSource(chosen);
        }
        videoControl.setActive(true);
        videoControl.setRate(engine.getPlayRate());
        const inPoint = Number(offset ?? 0);
        videoControl.seek(Math.max(0, time - action.start + (Number.isFinite(inPoint) ? inPoint : 0)), { force: true });
        if (isPlaying) {
          videoControl.play();
        }
      },
      update: ({ action, engine, time, isPlaying }) => {
        const { src, previewSrc, offset } = (action as CustomTimelineAction).data ?? ({} as any);
        const chosen = previewSrc || src;
        if (chosen) videoControl.setSource(chosen);
        videoControl.setActive(true);
        videoControl.setRate(engine.getPlayRate());
        // Smooth preview: NEVER seek while playing (seeks cause buffering).
        // When paused/scrubbing, we force seek to show the correct frame.
        if (!isPlaying) {
          const inPoint = Number(offset ?? 0);
          videoControl.seek(Math.max(0, time - action.start + (Number.isFinite(inPoint) ? inPoint : 0)), { force: true });
        }
      },
      leave: () => {
        videoControl.pause();
        videoControl.unbindEngine();
        videoControl.setActive(false);
      },
      stop: () => {
        videoControl.pause();
        videoControl.unbindEngine();
        videoControl.setActive(false);
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
];