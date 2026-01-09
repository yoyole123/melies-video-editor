/// <reference lib="webworker" />

import { FFmpeg } from '@ffmpeg/ffmpeg';
// import { toBlobURL } from '@ffmpeg/util';

type InMessage =
  | {
      type: 'transcode-video';
      assetKey: string;
      inputData: ArrayBuffer;
      debug?: boolean;
    }
  | { type: 'ping' };

type OutMessage =
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'progress'; assetKey: string; ratio: number }
  | { type: 'log'; assetKey: string; level: string; message: string }
  | { type: 'done'; assetKey: string; outVideoData: ArrayBuffer; outAudioData: ArrayBuffer }
  | { type: 'error'; assetKey: string; message: string };

const post = (msg: OutMessage) => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
};

let ffmpeg: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<void> | null = null;
let debugEnabled = false;

const ensureFfmpeg = async () => {
  if (ffmpeg && ffmpeg.loaded) return ffmpeg;
  if (!ffmpeg) ffmpeg = new FFmpeg();
  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      // Use direct URLs. We copy the ESM build of ffmpeg-core.js into /public/ffmpeg
      // (see scripts/copy-ffmpeg-core.mjs). The worker loads it via dynamic import().
      const base = new URL('/ffmpeg/', self.location.href).toString();
      const coreURL = `${base}ffmpeg-core.js`;
      const wasmURL = `${base}ffmpeg-core.wasm`;

      await ffmpeg!.load({ coreURL, wasmURL });
    })();
  }
  await ffmpegLoadPromise;
  return ffmpeg!;
};

const toExactArrayBuffer = (u8: Uint8Array): ArrayBuffer => {
  // Some environments may back typed arrays with SharedArrayBuffer.
  // Copy into a dedicated ArrayBuffer for safe structured-clone transfer.
  const out = new Uint8Array(u8.byteLength);
  out.set(u8);
  return out.buffer;
};

self.onmessage = async (ev: MessageEvent<InMessage>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'ping') {
      post({ type: 'pong' });
      return;
    }

    if (msg.type !== 'transcode-video') return;

    const { assetKey, inputData } = msg;
    debugEnabled = Boolean(msg.debug);

    const instance = await ensureFfmpeg();

    // Forward ffmpeg logs when debugging.
    const onLog = ({ type, message }: { type: string; message: string }) => {
      if (!debugEnabled) return;
      post({ type: 'log', assetKey, level: String(type ?? 'log'), message: String(message ?? '') });
    };
    instance.off('log', onLog as any);
    instance.on('log', onLog as any);

    // Progress callback is per FFmpeg instance; we emit tagged progress for this asset.
    const onProgress = ({ progress }: { progress: number }) => {
      const ratio = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
      post({ type: 'progress', assetKey, ratio });
    };

    instance.off('progress', onProgress as any);
    instance.on('progress', onProgress as any);

    // 1) Load raw bytes into ffmpeg FS
    const inputBytes = new Uint8Array(inputData);
    const inName = `in_${assetKey}.mp4`;
    const outVideoName = `out_${assetKey}.mp4`;
    const outAudioName = `out_${assetKey}.m4a`;

    await instance.writeFile(inName, inputBytes);

    // 2) Create proxy video (lower res, lower bitrate, faststart)
    // Keep audio in the proxy video as well for easy fallback.
    await instance.exec([
      '-hide_banner',
      '-y',
      '-i',
      inName,
      '-vf',
      'scale=w=1280:h=-2:force_original_aspect_ratio=decrease',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      outVideoName,
    ]);

    // 3) Create proxy audio-only stream (for Howler / precise audio sync)
    await instance.exec([
      '-hide_banner',
      '-y',
      '-i',
      inName,
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      outAudioName,
    ]);

    const outVideoData = await instance.readFile(outVideoName);
    const outAudioData = await instance.readFile(outAudioName);

    const outVideoBuf = toExactArrayBuffer(outVideoData as Uint8Array);
    const outAudioBuf = toExactArrayBuffer(outAudioData as Uint8Array);

    // Transfer buffers back to the main thread.
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(
      { type: 'done', assetKey, outVideoData: outVideoBuf, outAudioData: outAudioBuf } satisfies OutMessage,
      [outVideoBuf, outAudioBuf]
    );
  } catch (err) {
    const assetKey = (msg as any)?.assetKey ? String((msg as any).assetKey) : 'unknown';
    post({ type: 'error', assetKey, message: err instanceof Error ? err.message : String(err) });
  }
};

post({ type: 'ready' });
