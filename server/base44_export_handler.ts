// @ts-nocheck
// Base44 / Deno handler for the timeline "export" endpoint.
//
// IMPORTANT:
// - This file ports the logic from `server/index.mjs` (/export) to a Deno-style handler.
// - It requires an ffmpeg binary available at runtime and the ability to spawn subprocesses.
// - Many edge environments (including Deno Deploy) do NOT allow spawning `ffmpeg`.
//   If Base44 is using Deno Deploy handlers, you will likely need to run this handler
//   in a server environment that supports subprocesses, or call out to a dedicated
//   rendering service that runs ffmpeg.
//
// Request format (multipart/form-data):
// - field `timeline`: JSON string; must contain `{ editorData: any[] }`.
// - field `assets`: repeated file uploads; each file name should be the src key.
//   The client can send filename = encodeURIComponent(src).
//
// Response:
// - 200: mp4 file download `export.mp4`
// - 4xx/5xx: JSON error

function pathJoin(...parts: string[]) {
  const cleaned = parts
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const joined = cleaned.join("/");
  // Keep absolute paths absolute.
  if (parts[0]?.startsWith("/")) return "/" + joined;
  return joined;
}

function pathExtname(name: string) {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i);
}

const FFMPEG_PATH = Deno.env.get("FFMPEG_PATH") ?? "ffmpeg";

const TARGET_WIDTH = Number(Deno.env.get("EXPORT_WIDTH") ?? "1280");
const TARGET_HEIGHT = Number(Deno.env.get("EXPORT_HEIGHT") ?? "720");
const TARGET_FPS = Number(Deno.env.get("EXPORT_FPS") ?? "30");
const TARGET_AUDIO_RATE = Number(Deno.env.get("EXPORT_AUDIO_RATE") ?? "48000");

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function safeDecodeFilename(name: string | null | undefined) {
  if (!name) return "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function clampNonNegativeNumber(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

type Segment =
  | { type: "gap"; duration: number }
  | { type: "clip"; duration: number; src: string };

type Action = { start: number; end: number; src: string };

type EditorRow = { actions?: unknown[] };

type TimelinePayload = {
  editorData: EditorRow[];
};

function buildSegments(editorData: unknown, kind: "video" | "audio") {
  // kind: 'video' | 'audio'
  const effectIds = kind === "video" ? ["effect1"] : ["effect0", "effect2"];
  const actions: Action[] = [];
  const rows = Array.isArray(editorData) ? editorData : [];
  for (const row of rows) {
    const rowActions = (row as EditorRow | null | undefined)?.actions;
    if (!Array.isArray(rowActions)) continue;
    for (const action of rowActions) {
      if (!action || typeof action !== "object") continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a: any = action;
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
    if (start > t) segments.push({ type: "gap", duration: start - t });
    if (end > start) segments.push({ type: "clip", duration: end - start, src: a.src });
    t = Math.max(t, end);
  }
  return { segments, actions };
}

function collectActions(editorData: unknown, effectIds: string[]) {
  const actions: Action[] = [];
  const rows = Array.isArray(editorData) ? editorData : [];
  for (const row of rows) {
    const rowActions = (row as EditorRow | null | undefined)?.actions;
    if (!Array.isArray(rowActions)) continue;
    for (const action of rowActions) {
      if (!action || typeof action !== "object") continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a: any = action;
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
    const actions = (row as EditorRow | null | undefined)?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (!action || typeof action !== "object") continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a: any = action;
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

function buildFfmpegArgs(params: {
  editorData: unknown;
  assetsBySrc: Map<string, string>;
  outPath: string;
}) {
  const { editorData, assetsBySrc, outPath } = params;

  const totalDuration = getTotalDuration(editorData);
  const safeTotalDuration = totalDuration > 0 ? totalDuration : 0.04;

  const videoPlan = buildSegments(editorData, "video");
  // Audio is handled via mixing (supports overlaps / multiple layers).
  const audioActions = collectActions(editorData, ["effect0", "effect2"]);

  // If there are no video actions, generate a black video for the full duration.
  const videoSegments: Segment[] = videoPlan.segments.length
    ? [...videoPlan.segments]
    : [{ type: "gap", duration: totalDuration }];

  // Add trailing gaps to reach total duration.
  const sumDur = (segs: Segment[]) => segs.reduce((acc, s) => acc + (Number(s.duration) || 0), 0);
  const vSum = sumDur(videoSegments);
  if (totalDuration > vSum) videoSegments.push({ type: "gap", duration: totalDuration - vSum });

  const videoSrcs = uniqueStrings(
    videoSegments.filter((s) => s.type === "clip").map((s) => (s as { src: string }).src),
  );
  const audioSrcs = uniqueStrings(audioActions.map((a) => a.src));

  for (const src of [...videoSrcs, ...audioSrcs]) {
    if (!assetsBySrc.get(src)) {
      const err = new Error(`Missing asset for src: ${src}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).code = "MISSING_ASSET";
      throw err;
    }
  }

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];

  const inputIndexBySrc = new Map<string, number>();
  let inputIndex = 0;

  for (const src of videoSrcs) {
    const filePath = assetsBySrc.get(src)!;
    inputIndexBySrc.set(src, inputIndex++);
    args.push("-i", filePath);
  }

  for (const src of audioSrcs) {
    const filePath = assetsBySrc.get(src)!;
    // Loop audio inputs so short clips can fill longer timeline segments.
    inputIndexBySrc.set(src, inputIndex++);
    args.push("-stream_loop", "-1", "-i", filePath);
  }

  const filters: string[] = [];

  // Video segments
  const vLabels: string[] = [];
  for (let i = 0; i < videoSegments.length; i++) {
    const seg = videoSegments[i];
    const dur = Number(seg.duration);
    if (!Number.isFinite(dur) || dur <= 0) continue;

    const label = `vseg${vLabels.length}`;
    if (seg.type === "gap") {
      filters.push(
        `color=c=black:s=${TARGET_WIDTH}x${TARGET_HEIGHT}:r=${TARGET_FPS}:d=${dur},format=yuv420p[${label}]`,
      );
    } else {
      const idx = inputIndexBySrc.get(seg.src)!;
      filters.push(
        `[${idx}:v]trim=start=0:duration=${dur},setpts=PTS-STARTPTS,fps=${TARGET_FPS},` +
          `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
          `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `format=yuv420p[${label}]`,
      );
    }
    vLabels.push(`[${label}]`);
  }

  if (!vLabels.length) {
    // Degenerate case: totalDuration might be 0.
    filters.push(
      `color=c=black:s=${TARGET_WIDTH}x${TARGET_HEIGHT}:r=${TARGET_FPS}:d=0.04,format=yuv420p[vseg0]`,
    );
    vLabels.push("[vseg0]");
  }

  filters.push(`${vLabels.join("")}concat=n=${vLabels.length}:v=1:a=0[vout]`);

  // Audio actions (optional): mix overlapping clips across both audio layers.
  // Each action becomes a trimmed clip delayed to its start time, then everything is `amix`'d together.
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
          `aresample=${TARGET_AUDIO_RATE}:async=1,adelay=${delayMs}|${delayMs}[${label}]`,
      );
      aLabels.push(`[${label}]`);
    }

    const mixInputs = ["[abase]", ...aLabels];
    filters.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:normalize=0:duration=longest,` +
        `atrim=0:${safeTotalDuration},asetpts=PTS-STARTPTS[aout]`,
    );
  }

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "[vout]");
  if (audioActions.length && aLabels.length) {
    args.push("-map", "[aout]");
  } else {
    args.push("-an");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
  );
  if (aLabels.length) {
    args.push("-c:a", "aac", "-b:a", "192k");
  }

  args.push(outPath);

  return args;
}

async function runFfmpeg(args: string[], cwd: string) {
  const command = new Deno.Command(FFMPEG_PATH, {
    args,
    cwd,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  });

  const output = await command.output();
  const stderr = new TextDecoder().decode(output.stderr);
  if (output.code === 0) return { stderr };

  const err = new Error(`ffmpeg failed with code ${output.code}. ${stderr}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (err as any).code = "FFMPEG_FAILED";
  throw err;
}

function contentDisposition(filename: string) {
  // Basic, safe Content-Disposition for ASCII filenames.
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `attachment; filename="${safe}"`;
}

export async function handler(req: Request): Promise<Response> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  if (req.method === "GET" && new URL(req.url).pathname === "/health") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonError(405, "Method not allowed");
  }

  const pathname = new URL(req.url).pathname;
  if (pathname !== "/export") {
    return jsonError(404, "Not found");
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return jsonError(400, "Expected multipart/form-data");
  }

  let tmpDir: string | null = null;
  try {
    // NOTE: Deno Deploy may not allow filesystem writes.
    const workDir = await Deno.makeTempDir({ prefix: "timeline-export-" });
    tmpDir = workDir;

    const form = await req.formData();

    const timelineRaw = form.get("timeline");
    if (timelineRaw == null) {
      return jsonError(400, "Missing `timeline` field (JSON string).");
    }

    let timeline: TimelinePayload;
    try {
      timeline = JSON.parse(String(timelineRaw));
    } catch {
      return jsonError(400, "Invalid JSON in `timeline`.");
    }

    const editorData = (timeline as any)?.editorData;
    if (!Array.isArray(editorData)) {
      return jsonError(400, "`timeline.editorData` must be an array.");
    }

    const assetsBySrc = new Map<string, string>();

    // In browsers, repeated field `assets` becomes multiple entries.
    for (const entry of form.getAll("assets")) {
      if (!(entry instanceof File)) continue;
      const src = safeDecodeFilename(entry.name);
      if (!src) continue;

      const safeExt = pathExtname(entry.name || "") || ".bin";
      const filePath = pathJoin(workDir, `asset-${crypto.randomUUID()}${safeExt}`);
      const bytes = new Uint8Array(await entry.arrayBuffer());
      await Deno.writeFile(filePath, bytes);
      assetsBySrc.set(src, filePath);
    }

    const outPath = pathJoin(workDir, "export.mp4");
    const ffmpegArgs = buildFfmpegArgs({ editorData, assetsBySrc, outPath });

    await runFfmpeg(ffmpegArgs, workDir);

    const mp4 = await Deno.readFile(outPath);

    return new Response(mp4, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-disposition": contentDisposition("export.mp4"),
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any)?.code;
    if (code === "MISSING_ASSET") {
      return jsonError(400, msg);
    }
    if (code === "FFMPEG_FAILED") {
      return jsonError(500, msg);
    }
    return jsonError(500, msg);
  } finally {
    if (tmpDir) {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }
}

// Common Base44/Deno-deploy style default export.
export default handler;
