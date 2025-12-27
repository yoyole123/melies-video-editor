import express from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const PORT = Number(process.env.EXPORT_SERVER_PORT ?? 5174);
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';

const TARGET_WIDTH = Number(process.env.EXPORT_WIDTH ?? 1280);
const TARGET_HEIGHT = Number(process.env.EXPORT_HEIGHT ?? 720);
const TARGET_FPS = Number(process.env.EXPORT_FPS ?? 30);
const TARGET_AUDIO_RATE = Number(process.env.EXPORT_AUDIO_RATE ?? 48000);

const app = express();

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

function safeDecodeFilename(name) {
  if (!name) return '';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function clampNonNegativeNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function buildSegments(editorData, kind) {
  // kind: 'video' | 'audio'
  const effectId = kind === 'video' ? 'effect1' : 'effect0';
  const actions = [];
  const rows = Array.isArray(editorData) ? editorData : [];
  for (const row of rows) {
    const rowActions = row?.actions;
    if (!Array.isArray(rowActions)) continue;
    for (const action of rowActions) {
      if (!action) continue;
      if (String(action.effectId) !== effectId) continue;
      const start = clampNonNegativeNumber(action.start);
      const end = clampNonNegativeNumber(action.end);
      const src = action?.data?.src;
      if (!src) continue;
      if (end <= start) continue;
      actions.push({ start, end, src: String(src) });
    }
  }

  actions.sort((a, b) => a.start - b.start);

  // Convert to a gap+clip segment list, clamping overlaps.
  const segments = [];
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

function getTotalDuration(editorData) {
  let maxEnd = 0;
  const rows = Array.isArray(editorData) ? editorData : [];
  for (const row of rows) {
    const actions = row?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      const end = clampNonNegativeNumber(action?.end);
      if (end > maxEnd) maxEnd = end;
    }
  }
  return maxEnd;
}

function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function buildFfmpegArgs({ editorData, assetsBySrc, outPath }) {
  const totalDuration = getTotalDuration(editorData);

  const videoPlan = buildSegments(editorData, 'video');
  const audioPlan = buildSegments(editorData, 'audio');

  // If there are no video actions, generate a black video for the full duration.
  const videoSegments = videoPlan.segments.length ? [...videoPlan.segments] : [{ type: 'gap', duration: totalDuration }];
  const audioSegments = [...audioPlan.segments];

  // Add trailing gaps to reach total duration.
  const sumDur = (segs) => segs.reduce((acc, s) => acc + (Number(s.duration) || 0), 0);
  const vSum = sumDur(videoSegments);
  const aSum = sumDur(audioSegments);
  if (totalDuration > vSum) videoSegments.push({ type: 'gap', duration: totalDuration - vSum });
  if (totalDuration > aSum && audioSegments.length) audioSegments.push({ type: 'gap', duration: totalDuration - aSum });

  const videoSrcs = uniqueStrings(videoSegments.filter((s) => s.type === 'clip').map((s) => s.src));
  const audioSrcs = uniqueStrings(audioSegments.filter((s) => s.type === 'clip').map((s) => s.src));

  for (const src of [...videoSrcs, ...audioSrcs]) {
    if (!assetsBySrc.get(src)) {
      const err = new Error(`Missing asset for src: ${src}`);
      err.code = 'MISSING_ASSET';
      throw err;
    }
  }

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  const inputIndexBySrc = new Map();
  let inputIndex = 0;

  for (const src of videoSrcs) {
    const filePath = assetsBySrc.get(src);
    inputIndexBySrc.set(src, inputIndex++);
    args.push('-i', filePath);
  }

  for (const src of audioSrcs) {
    const filePath = assetsBySrc.get(src);
    // Loop audio inputs so short clips can fill longer timeline segments.
    inputIndexBySrc.set(src, inputIndex++);
    args.push('-stream_loop', '-1', '-i', filePath);
  }

  const filters = [];

  // Video segments
  const vLabels = [];
  for (let i = 0; i < videoSegments.length; i++) {
    const seg = videoSegments[i];
    const dur = Number(seg.duration);
    if (!Number.isFinite(dur) || dur <= 0) continue;

    const label = `vseg${vLabels.length}`;
    if (seg.type === 'gap') {
      filters.push(
        `color=c=black:s=${TARGET_WIDTH}x${TARGET_HEIGHT}:r=${TARGET_FPS}:d=${dur},format=yuv420p[${label}]`
      );
    } else {
      const idx = inputIndexBySrc.get(seg.src);
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
    // Degenerate case: totalDuration might be 0.
    filters.push(
      `color=c=black:s=${TARGET_WIDTH}x${TARGET_HEIGHT}:r=${TARGET_FPS}:d=0.04,format=yuv420p[vseg0]`
    );
    vLabels.push('[vseg0]');
  }

  filters.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vout]`);

  // Audio segments (optional)
  const aLabels = [];
  if (audioSegments.length) {
    for (let i = 0; i < audioSegments.length; i++) {
      const seg = audioSegments[i];
      const dur = Number(seg.duration);
      if (!Number.isFinite(dur) || dur <= 0) continue;

      const label = `aseg${aLabels.length}`;
      if (seg.type === 'gap') {
        filters.push(`anullsrc=r=${TARGET_AUDIO_RATE}:cl=stereo:d=${dur}[${label}]`);
      } else {
        const idx = inputIndexBySrc.get(seg.src);
        filters.push(
          `[${idx}:a]atrim=start=0:duration=${dur},asetpts=PTS-STARTPTS,aresample=${TARGET_AUDIO_RATE}:async=1[${label}]`
        );
      }
      aLabels.push(`[${label}]`);
    }

    if (aLabels.length) {
      filters.push(`${aLabels.join('')}concat=n=${aLabels.length}:v=0:a=1[aout]`);
    }
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]');
  if (aLabels.length) {
    args.push('-map', '[aout]');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart'
  );
  if (aLabels.length) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  args.push(outPath);

  return args;
}

function runFfmpeg(args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) return resolve({ stderr });
      const err = new Error(`ffmpeg failed with code ${code}. ${stderr}`);
      err.code = 'FFMPEG_FAILED';
      reject(err);
    });
  });
}

// Dynamic temp dir per request + disk uploads.
app.post(
  '/export',
  (req, _res, next) => {
    req._exportTmpDir = path.join(os.tmpdir(), `timeline-export-${randomUUID()}`);
    fs.mkdirSync(req._exportTmpDir, { recursive: true });
    next();
  },
  multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => cb(null, req._exportTmpDir),
      filename: (_req, file, cb) => {
        // Keep a safe filename on disk. We still use originalname to map back to src.
        const safe = `asset-${randomUUID()}${path.extname(file.originalname || '')}`;
        cb(null, safe);
      },
    }),
    limits: {
      fileSize: Number(process.env.EXPORT_MAX_FILE_BYTES ?? 2_000_000_000),
      files: Number(process.env.EXPORT_MAX_FILES ?? 64),
    },
  }).array('assets'),
  async (req, res) => {
    const tmpDir = req._exportTmpDir;
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);

    try {
      const timelineRaw = req.body?.timeline;
      if (!timelineRaw) {
        res.status(400).json({ error: 'Missing `timeline` field (JSON string).' });
        return;
      }

      let timeline;
      try {
        timeline = JSON.parse(String(timelineRaw));
      } catch {
        res.status(400).json({ error: 'Invalid JSON in `timeline`.' });
        return;
      }

      const editorData = timeline?.editorData;
      if (!Array.isArray(editorData)) {
        res.status(400).json({ error: '`timeline.editorData` must be an array.' });
        return;
      }

      const files = Array.isArray(req.files) ? req.files : [];
      const assetsBySrc = new Map();
      for (const f of files) {
        const original = safeDecodeFilename(f.originalname);
        // Client should send filename = encodeURIComponent(src)
        const src = original;
        if (!src) continue;
        assetsBySrc.set(src, f.path);
      }

      const outPath = path.join(tmpDir, 'export.mp4');
      const ffmpegArgs = buildFfmpegArgs({ editorData, assetsBySrc, outPath });

      await runFfmpeg(ffmpegArgs, { cwd: tmpDir });

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="export.mp4"');
      res.sendFile(outPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err?.code;
      if (code === 'MISSING_ASSET') {
        res.status(400).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  }
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Export server listening on http://localhost:${PORT}`);
});
