import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(projectRoot, 'public', 'ffmpeg');

const coreDist = path.join(projectRoot, 'node_modules', '@ffmpeg', 'core', 'dist');

// IMPORTANT: the FFmpeg worker loads `coreURL` via dynamic `import()`.
// That requires an ES module build of ffmpeg-core.js.
const candidates = [
  // Prefer ESM: @ffmpeg/ffmpeg loads coreURL via dynamic import() inside a module worker.
  { base: path.join(coreDist, 'esm'), files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'] },
  // Fallbacks.
  { base: path.join(coreDist, 'umd'), files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'] },
  { base: coreDist, files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'] },
];

const ensureDir = (p) => {
  fs.mkdirSync(p, { recursive: true });
};

const tryCopy = (base, files) => {
  if (!fs.existsSync(base)) return false;
  const ok = files.every((f) => fs.existsSync(path.join(base, f)));
  if (!ok) return false;

  ensureDir(outDir);
  for (const f of files) {
    fs.copyFileSync(path.join(base, f), path.join(outDir, f));
  }
  return true;
};

let copied = false;
for (const c of candidates) {
  copied = tryCopy(c.base, c.files);
  if (copied) break;
}

if (!copied) {
  // Don't fail install; it may be a CI environment.
  // The app will fall back to raw playback if core files are missing.
  console.warn('[copy-ffmpeg-core] Could not locate ffmpeg core assets in node_modules.');
  console.warn('[copy-ffmpeg-core] Expected @ffmpeg/core. If installed, inspect node_modules/@ffmpeg/core/dist/*');
}
