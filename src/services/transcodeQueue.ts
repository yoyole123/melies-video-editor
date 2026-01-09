import opfsStore, {
  stableKeyForFile,
  stableKeyForUrl,
  type AssetManifestRecord,
} from './opfsStore';

import { FFmpeg } from '@ffmpeg/ffmpeg';

type PrepareInput =
  | {
      kind: 'video';
      src: string;
      file?: File;
      nameHint?: string;
      mimeTypeHint?: string;
    }
  | {
      kind: 'audio';
      src: string;
      file?: File;
      nameHint?: string;
      mimeTypeHint?: string;
    };

export type PrepareProgress = {
  src: string;
  assetKey: string;
  stage: 'unsupported' | 'queued' | 'writing-raw' | 'transcoding' | 'ready' | 'error';
  ratio: number;
  message?: string;
  proxyVideoUrl?: string;
  proxyAudioUrl?: string;
};

type Listener = (p: PrepareProgress) => void;

const canUseFfmpeg = () => {
  // FFmpeg.wasm fast path requires crossOriginIsolated (SharedArrayBuffer).
  return Boolean((globalThis as any).crossOriginIsolated);
};

const debugProxyEnabled = () => {
  try {
    const ls = globalThis.localStorage?.getItem('melies.debugProxy');
    if (ls === '1' || ls === 'true') return true;
  } catch {
    // ignore
  }
  try {
    const sp = new URLSearchParams(globalThis.location?.search ?? '');
    return sp.get('debugProxy') === '1' || sp.get('debugProxy') === 'true';
  } catch {
    return false;
  }
};

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<void> | null = null;

const ensureFfmpegLoaded = async (): Promise<FFmpeg> => {
  if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance;
  if (!ffmpegInstance) ffmpegInstance = new FFmpeg();
  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      const origin = (globalThis.location as any)?.origin ?? new URL(globalThis.location?.href ?? '').origin;
      const base = `${origin}/ffmpeg/`;
      const coreURL = `${base}ffmpeg-core.js`;
      const wasmURL = `${base}ffmpeg-core.wasm`;
      await ffmpegInstance!.load({ coreURL, wasmURL });
    })();
  }
  await ffmpegLoadPromise;
  return ffmpegInstance!;
};

class TranscodeQueue {
  private queue: Array<{
    input: PrepareInput;
    resolve: (p: PrepareProgress) => void;
    reject: (err: Error) => void;
  }> = [];

  private running = false;
  private listeners = new Set<Listener>();

  private proxyUrlByPath = new Map<string, string>();

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(p: PrepareProgress) {
    for (const l of this.listeners) l(p);
  }

  enqueue(input: PrepareInput): Promise<PrepareProgress> {
    return new Promise((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      void this.pump();
    });
  }

  private assetKeyFor(input: PrepareInput): string {
    if (input.file) return stableKeyForFile(input.file);
    return stableKeyForUrl(input.src);
  }

  private async createObjectUrlForPath(path: string): Promise<string> {
    const existing = this.proxyUrlByPath.get(path);
    if (existing) return existing;
    const file = await opfsStore.readFile(path);
    const url = URL.createObjectURL(file);
    this.proxyUrlByPath.set(path, url);
    return url;
  }

  private async ensureRaw(record: AssetManifestRecord, input: PrepareInput) {
    if (input.file) {
      await opfsStore.ensureRawFromFile(record, input.file);
    } else {
      await opfsStore.ensureRawFromUrl(record, input.src);
    }
  }

  private async readRawBytes(record: AssetManifestRecord): Promise<ArrayBuffer> {
    const file = await opfsStore.readFile(record.raw);
    return file.arrayBuffer();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        const { input } = job;
        const assetKey = this.assetKeyFor(input);

        if (input.kind !== 'video') {
          // Not yet implemented: audio proxy generation (we can add later if needed).
          const result: PrepareProgress = {
            src: input.src,
            assetKey,
            stage: 'ready',
            ratio: 1,
          };
          job.resolve(result);
          this.emit(result);
          continue;
        }

        if (!canUseFfmpeg()) {
          const unsupported: PrepareProgress = {
            src: input.src,
            assetKey,
            stage: 'unsupported',
            ratio: 0,
            message: 'Proxy optimization unavailable (requires crossOriginIsolated via COOP/COEP).',
          };
          job.resolve(unsupported);
          this.emit(unsupported);
          continue;
        }

        const record = await opfsStore.getOrCreateRecord({
          key: assetKey,
          kind: 'video',
          name: input.nameHint,
          mimeType: input.mimeTypeHint,
        });

        const outVideoPath = record.proxyVideo ?? `proxy/${assetKey}/video.mp4`;
        const outAudioPath = record.proxyAudio ?? `proxy/${assetKey}/audio.m4a`;

        // If already done, return immediately.
        const already = (await opfsStore.exists(outVideoPath)) && (await opfsStore.exists(outAudioPath));
        if (already) {
          const proxyVideoUrl = await this.createObjectUrlForPath(outVideoPath);
          const proxyAudioUrl = await this.createObjectUrlForPath(outAudioPath);
          const ready: PrepareProgress = {
            src: input.src,
            assetKey,
            stage: 'ready',
            ratio: 1,
            proxyVideoUrl,
            proxyAudioUrl,
          };
          job.resolve(ready);
          this.emit(ready);
          continue;
        }

        this.emit({ src: input.src, assetKey, stage: 'writing-raw', ratio: 0.05 });
        await this.ensureRaw(record, input);

        await opfsStore.updateRecord(assetKey, { proxyVideo: outVideoPath, proxyAudio: outAudioPath });

        const debug = debugProxyEnabled();
        this.emit({ src: input.src, assetKey, stage: 'queued', ratio: 0.05 });

        let inputData: ArrayBuffer;
        try {
          inputData = await this.readRawBytes(record);
        } catch (err) {
          const failed: PrepareProgress = {
            src: input.src,
            assetKey,
            stage: 'error',
            ratio: 0,
            message: `Failed to read raw from OPFS: ${await opfsStore.getReadableError(err)}`,
          };
          job.resolve(failed);
          this.emit(failed);
          continue;
        }

        try {
          const instance = await ensureFfmpegLoaded();

          const onLog = ({ type, message }: { type: string; message: string }) => {
            if (!debug) return;
            // eslint-disable-next-line no-console
            console.log(`[proxy][${assetKey}][${String(type ?? 'log')}] ${String(message ?? '')}`);
          };
          instance.off('log', onLog as any);
          instance.on('log', onLog as any);

          const inputBytes = new Uint8Array(inputData);
          const inName = `in_${assetKey}.mp4`;
          const outVideoName = `out_${assetKey}.mp4`;
          const outAudioName = `out_${assetKey}.m4a`;

          await instance.writeFile(inName, inputBytes);

          // 2) Proxy video (0%..70% of transcode stage)
          const onProgressVideo = ({ progress }: { progress: number }) => {
            const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
            this.emit({ src: input.src, assetKey, stage: 'transcoding', ratio: 0.05 + 0.95 * (0.7 * p) });
          };
          instance.off('progress', onProgressVideo as any);
          instance.on('progress', onProgressVideo as any);

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

          instance.off('progress', onProgressVideo as any);

          // 3) Proxy audio-only (70%..100% of transcode stage)
          const onProgressAudio = ({ progress }: { progress: number }) => {
            const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
            this.emit({ src: input.src, assetKey, stage: 'transcoding', ratio: 0.05 + 0.95 * (0.7 + 0.3 * p) });
          };
          instance.off('progress', onProgressAudio as any);
          instance.on('progress', onProgressAudio as any);

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

          instance.off('progress', onProgressAudio as any);

          const outVideoData = (await instance.readFile(outVideoName)) as Uint8Array;
          const outAudioData = (await instance.readFile(outAudioName)) as Uint8Array;

          // Best-effort cleanup inside ffmpeg FS.
          try {
            await instance.deleteFile(inName);
            await instance.deleteFile(outVideoName);
            await instance.deleteFile(outAudioName);
          } catch {
            // ignore
          }

          // Avoid passing SharedArrayBuffer through typings/structured clone.
          await opfsStore.writeFile(outVideoPath, outVideoData);
          await opfsStore.writeFile(outAudioPath, outAudioData);

          const proxyVideoUrl = await this.createObjectUrlForPath(outVideoPath);
          const proxyAudioUrl = await this.createObjectUrlForPath(outAudioPath);
          const ready: PrepareProgress = {
            src: input.src,
            assetKey,
            stage: 'ready',
            ratio: 1,
            proxyVideoUrl,
            proxyAudioUrl,
          };
          job.resolve(ready);
          this.emit(ready);
        } catch (err) {
          const failed: PrepareProgress = {
            src: input.src,
            assetKey,
            stage: 'error',
            ratio: 0,
            message: err instanceof Error ? err.message : String(err),
          };
          if (debug) {
            // eslint-disable-next-line no-console
            console.warn(`[proxy][${assetKey}] error: ${failed.message}`);
          }
          job.resolve(failed);
          this.emit(failed);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

const transcodeQueue = new TranscodeQueue();
export default transcodeQueue;
