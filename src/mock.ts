import type { TimelineAction, TimelineEffect, TimelineRow } from '@xzdarcy/react-timeline-editor';
import audioControl from './audioControl';
import videoControl from './videoControl';

export const scaleWidth = 160;
export const scale = 5;
export const startLeft = 20;

export interface CustomTimelineAction extends TimelineAction {
  data: {
    src: string;
    name: string;
  };
}

export interface CusTomTimelineRow extends TimelineRow {
  actions: CustomTimelineAction[];
}

export const mockEffect: Record<string, TimelineEffect> = {
  effect0: {
    id: 'effect0',
    name: '播放音效',
    source: {
      start: ({ action, engine, isPlaying, time }) => {
        if (isPlaying) {
          const src = (action as CustomTimelineAction).data.src;
          audioControl.start({ id: src, src, startTime: action.start, engine, time });
        }
      },
      enter: ({ action, engine, isPlaying, time }) => {
        if (isPlaying) {
          const src = (action as CustomTimelineAction).data.src;
          audioControl.start({ id: src, src, startTime: action.start, engine, time });
        }
      },
      leave: ({ action, engine }) => {
        const src = (action as CustomTimelineAction).data.src;
        audioControl.stop({ id: src, engine });
      },
      stop: ({ action, engine }) => {
        const src = (action as CustomTimelineAction).data.src;
        audioControl.stop({ id: src, engine });
      },
    },
  },
  effect1: {
    id: 'effect1',
    name: '播放视频',
    source: {
      start: ({ action, engine, isPlaying, time }) => {
        videoControl.setRate(engine.getPlayRate());
        videoControl.seek(Math.max(0, time - action.start));
        if (isPlaying) videoControl.play();
      },
      enter: ({ action, engine, isPlaying, time }) => {
        videoControl.setRate(engine.getPlayRate());
        videoControl.seek(Math.max(0, time - action.start));
        if (isPlaying) videoControl.play();
      },
      update: ({ action, engine, time }) => {
        videoControl.setRate(engine.getPlayRate());
        videoControl.seek(Math.max(0, time - action.start));
      },
      leave: () => {
        videoControl.pause();
      },
      stop: () => {
        videoControl.pause();
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