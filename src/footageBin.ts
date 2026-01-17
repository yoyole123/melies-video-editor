export type FootageItem = {
  id: string;
  kind: 'video' | 'audio';
  name: string;
  src: string;
  /** Optional lower-res/proxy source for smooth preview playback. */
  previewSrc?: string;
  defaultDuration?: number;
};

// "Finalized bin" for editing mode.
// These are served from public/footage/*.
export const FOOTAGE_BIN: FootageItem[] = [
  {
    id: 'bbb-10s',
    kind: 'video',
    name: 'Big Buck Bunny (10s)',
    src: '/footage/Big_Buck_Bunny_720_10s_5MB.mp4',
  },
  {
    id: 'example-mp4',
    kind: 'video',
    name: 'Example MP4 (≈10s)',
    src: '/footage/file_example_MP4_1280_10MG.mp4',
  },
  {
    id: 'example-mp3',
    kind: 'audio',
    name: 'Example MP3 (looped)',
    src: '/footage/file_example_MP3_700KB.mp3',
  },
  {
    id: 'braveheart',
    kind: 'video',
    name: 'Braveheart (≈13s)',
    src: '/footage/braveheart.mp4',
  }
];

export const VIDEO_ITEMS = FOOTAGE_BIN.filter((x) => x.kind === 'video');
export const AUDIO_ITEMS = FOOTAGE_BIN.filter((x) => x.kind === 'audio');
