import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export class TranscoderService {
  private ffmpeg: FFmpeg | null = null;
  private loaded = false;

  async load() {
    if (this.loaded) return;

    this.ffmpeg = new FFmpeg();

    // Use local files from /public/ffmpeg/ to ensure they are served with the same origin
    // and thus comply with COEP/COOP headers.
    // 
    // IMPORTANT: We use toBlobURL to fetch the file content first and creating a blob URL manually.
    // This often bypasses path resolution issues when the worker tries to load the wasm file relative to itself.
    // Also, since we already have the files locally in public/ffmpeg, we just point to them.
    // Note: We are using the UMD build now (copied to public/ffmpeg) as ESM sometimes causes
    // issues with self.location in workers.
    const coreURL = await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript');
    const wasmURL = await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm');

    await this.ffmpeg.load({
      coreURL,
      wasmURL,
      // explicit workerURL is usually not needed if we load the blob, but if it fails again
      // we might need to construct a blob for the worker too.
    });

    this.loaded = true;
  }

  async generateProxy(file: File, onProgress: (progress: number) => void): Promise<Blob> {
    if (!this.loaded) await this.load();
    const ffmpeg = this.ffmpeg!;

    const inputName = 'input.' + file.name.split('.').pop();
    const outputName = 'proxy.mp4';

    await ffmpeg.writeFile(inputName, await fetchFile(file));

    ffmpeg.on('progress', ({ progress }) => {
      onProgress(progress);
    });

    // Simple transcode: 540p, fast preset, AAC audio
    // -vf "scale=-2:540" scales height to 540, width automatically to keep aspect ratio (ensuring divisible by 2)
    // -crf 28 lower quality for smaller size/speed
    await ffmpeg.exec([
      '-i', inputName,
      '-vf', 'scale=-2:540',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputName
    ]);

    const data = await ffmpeg.readFile(outputName);
    
    // Cleaning up
    // await ffmpeg.deleteFile(inputName);
    // await ffmpeg.deleteFile(outputName);
    
    return new Blob([data], { type: 'video/mp4' });
  }
}

export const transcoder = new TranscoderService();
