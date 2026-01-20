import { spawn } from 'node:child_process';

const TARGET_WIDTH = Number(process.env.EXPORT_WIDTH ?? 1280);
const TARGET_HEIGHT = Number(process.env.EXPORT_HEIGHT ?? 720);
const TARGET_FPS = Number(process.env.EXPORT_FPS ?? 30);
const TARGET_AUDIO_RATE = Number(process.env.EXPORT_AUDIO_RATE ?? 48000);

export type Segment =
  | { type: 'gap'; duration: number }
  | { type: 'clip'; duration: number; src: string };

export type TimelineAction = { start: number; end: number; src: string };

function clampNonNegativeNumber(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function buildSegments(editorData: unknown, kind: 'video' | 'audio') {
  // kind: 'video' | 'audio'
  const effectIds = kind === 'video' ? ['effect1'] : ['effect0', 'effect2'];
  const actions: TimelineAction[] = [];
  const rows = Array.isArray(editorData) ? editorData : [];
  for (const row of rows) {
    const rowActions = (row as { actions?: unknown[] } | null | undefined)?.actions;
    if (!Array.isArray(rowActions)) continue;
    for (const action of rowActions) {
      if (!action || typeof action !== 'object') continue;
      const a = action as { effectId?: unknown; start?: unknown; end?: unknown; data?: { src?: unknown } };
      if (!effectIds.includes(String(a.effectId))) continue;
      const start = clampNonNegativeNumber(a.start);
      const end = clampNonNegativeNumber(a.end);
      const src = a?.data?.src;
      if (!src) continue;
      if (end <= start) continue;
      actions.push({ start, end, src: String(src) });
    }
  }

  actions.sort((a, b) => a.start - b.start);

  // Convert to a gap+clip segment list, clamping overlaps.
  const segments: Segment[] = [];
  let t = 0;
  for (const a of actions) {
    const start = Math.max(t, a.start);
    const end = Math.max(start, a.end);
    if (start > t) segments.push({ type: 'gap', duration: start - t });
    if (end > start) segments.push({ type: 'clip', duration: end - start, src: a.src });
    t = Math.max(t, end);
  }

  return { segments, actions };
}

function collectActions(editorData: unknown, effectIds: string[]) {
  const actions: TimelineAction[] = [];
  const rows = Array.isArray(editorData) ? editorData : [];
  for (const row of rows) {
    const rowActions = (row as { actions?: unknown[] } | null | undefined)?.actions;
    if (!Array.isArray(rowActions)) continue;
    for (const action of rowActions) {
      if (!action || typeof action !== 'object') continue;
      const a = action as { effectId?: unknown; start?: unknown; end?: unknown; data?: { src?: unknown } };
      if (!effectIds.includes(String(a.effectId))) continue;
      const start = clampNonNegativeNumber(a.start);
      const end = clampNonNegativeNumber(a.end);
      const src = a?.data?.src;
      if (!src) continue;
      if (end <= start) continue;
      actions.push({ start, end, src: String(src) });
    }
  }
  actions.sort((a, b) => a.start - b.start);
  return actions;
}

function getTotalDuration(editorData: unknown) {
  let maxEnd = 0;
  const rows = Array.isArray(editorData) ? editorData : [];
  for (const row of rows) {
    const actions = (row as { actions?: unknown[] } | null | undefined)?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;
      const a = action as { end?: unknown };
      const end = clampNonNegativeNumber(a?.end);
      if (end > maxEnd) maxEnd = end;
    }
  }
  return maxEnd;
}

function uniqueStrings(items: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Builds ffmpeg CLI args for the given editorData + asset map.
 */
export function buildFfmpegArgs(params: {
  editorData: unknown;
  assetsBySrc: Map<string, string>;
  outPath: string;
}): string[] {
  const { editorData, assetsBySrc, outPath } = params;

  const totalDuration = getTotalDuration(editorData);
  const safeTotalDuration = totalDuration > 0 ? totalDuration : 0.04;

  const videoPlan = buildSegments(editorData, 'video');
  // Audio is handled via mixing (supports overlaps / multiple layers).
  const audioActions = collectActions(editorData, ['effect0', 'effect2']);

  // If there are no video actions, generate a black video for the full duration.
  const videoSegments: Segment[] = videoPlan.segments.length
    ? [...videoPlan.segments]
    : [{ type: 'gap', duration: totalDuration }];

  // Add trailing gaps to reach total duration.
  const sumDur = (segs: Segment[]) => segs.reduce((acc, s) => acc + (Number(s.duration) || 0), 0);
  const vSum = sumDur(videoSegments);
  if (totalDuration > vSum) videoSegments.push({ type: 'gap', duration: totalDuration - vSum });

  const videoSrcs = uniqueStrings(videoSegments.filter((s) => s.type === 'clip').map((s) => (s as any).src));
  const audioSrcs = uniqueStrings(audioActions.map((a) => a.src));

  for (const src of [...videoSrcs, ...audioSrcs]) {
    if (!assetsBySrc.get(src)) {
      const err = new Error(`Missing asset for src: ${src}`);
      (err as any).code = 'MISSING_ASSET';
      throw err;
    }
  }

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];

  const inputIndexBySrc = new Map<string, number>();
  let inputIndex = 0;

  for (const src of videoSrcs) {
    const filePath = assetsBySrc.get(src)!;
    inputIndexBySrc.set(src, inputIndex++);
    args.push('-i', filePath);
  }

  for (const src of audioSrcs) {
    const filePath = assetsBySrc.get(src)!;
    // Loop audio inputs so short clips can fill longer timeline segments.
    inputIndexBySrc.set(src, inputIndex++);
    args.push('-stream_loop', '-1', '-i', filePath);
  }

  const filters: string[] = [];

  // Video segments
  const vLabels: string[] = [];
  for (const seg of videoSegments) {
    const dur = Number(seg.duration);
    if (!Number.isFinite(dur) || dur <= 0) continue;

    const label = `vseg${vLabels.length}`;
    if (seg.type === 'gap') {
      filters.push(`color=c=black:s=${TARGET_WIDTH}x${TARGET_HEIGHT}:r=${TARGET_FPS}:d=${dur},format=yuv420p[${label}]`);
    } else {
      const idx = inputIndexBySrc.get(seg.src)!;
      filters.push(
        `[${idx}:v]trim=start=0:duration=${dur},setpts=PTS-STARTPTS,fps=${TARGET_FPS},` +
          `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
          `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `format=yuv420p[${label}]`
      );
    }
    vLabels.push(`[${label}]`);
  }

  if (!vLabels.length) {
    filters.push(`color=c=black:s=${TARGET_WIDTH}x${TARGET_HEIGHT}:r=${TARGET_FPS}:d=0.04,format=yuv420p[vseg0]`);
    vLabels.push('[vseg0]');
  }

  filters.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vout]`);

  // Audio actions (optional): mix overlapping clips across both audio layers.
  const aLabels: string[] = [];
  if (audioActions.length) {
    // Base silence to guarantee output length.
    filters.push(`anullsrc=r=${TARGET_AUDIO_RATE}:cl=stereo:d=${safeTotalDuration}[abase]`);

    for (const action of audioActions) {
      const dur = Number(action.end) - Number(action.start);
      if (!Number.isFinite(dur) || dur <= 0) continue;
      const idx = inputIndexBySrc.get(action.src)!;
      const delayMs = Math.max(0, Math.round(Number(action.start) * 1000));
      const label = `am${aLabels.length}`;
      filters.push(
        `[${idx}:a]atrim=start=0:duration=${dur},asetpts=PTS-STARTPTS,` +
          `aresample=${TARGET_AUDIO_RATE}:async=1,adelay=${delayMs}|${delayMs}[${label}]`
      );
      aLabels.push(`[${label}]`);
    }

    const mixInputs = ['[abase]', ...aLabels];
    filters.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:normalize=0:duration=longest,` +
        `atrim=0:${safeTotalDuration},asetpts=PTS-STARTPTS[aout]`
    );
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]');

  if (audioActions.length && aLabels.length) {
    args.push('-map', '[aout]');
  } else {
    args.push('-an');
  }

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');

  if (aLabels.length) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  args.push(outPath);

  return args;
}

/**
 * Runs ffmpeg and returns captured stderr (truncated).
 */
export async function runFfmpeg(params: { ffmpegPath: string; args: string[]; cwd: string }): Promise<{ stderr: string }> {
  const { ffmpegPath, args, cwd } = params;

  return await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code === 0) return resolve({ stderr });
      const err = new Error(`ffmpeg failed with code ${code}. ${stderr}`);
      (err as any).code = 'FFMPEG_FAILED';
      reject(err);
    });
  });
}
