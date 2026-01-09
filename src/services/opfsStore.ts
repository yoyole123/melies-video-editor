export type OpfsFilePath = string;

const OPFS_ROOT_DIR = 'melies-video-editor';
const OPFS_VERSION_DIR = 'v1';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const asErrorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
};

const sanitizeSegment = (s: string) => {
  // Keep it filesystem-friendly.
  return s.replaceAll(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
};

export const stableKeyForUrl = (url: string) => {
  // URLs can contain slashes; keep them but sanitize to a single segment.
  return `url_${sanitizeSegment(url)}`;
};

export const stableKeyForFile = (file: File) => {
  const name = sanitizeSegment(file.name || 'file');
  const size = Number(file.size || 0);
  const lm = Number((file as any).lastModified || 0);
  return `file_${name}_${size}_${lm}`;
};

export type AssetManifestRecord = {
  key: string;
  kind: 'video' | 'audio' | 'other';
  raw: OpfsFilePath;
  proxyVideo?: OpfsFilePath;
  proxyAudio?: OpfsFilePath;
  createdAtMs: number;
  updatedAtMs: number;
  name?: string;
  mimeType?: string;
};

export type AssetManifest = {
  version: 1;
  recordsByKey: Record<string, AssetManifestRecord>;
};

const defaultManifest = (): AssetManifest => ({ version: 1, recordsByKey: {} });

class OpfsStore {
  private dirPromise: Promise<FileSystemDirectoryHandle> | null = null;

  private async getRootDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.dirPromise) {
      this.dirPromise = (async () => {
        const root = await navigator.storage.getDirectory();
        const appDir = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
        const versionDir = await appDir.getDirectoryHandle(OPFS_VERSION_DIR, { create: true });
        return versionDir;
      })();
    }
    return this.dirPromise;
  }

  private async getDir(pathParts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = await this.getRootDir();
    for (const raw of pathParts) {
      const part = sanitizeSegment(String(raw ?? ''));
      if (!part) continue;
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  }

  private async getFileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const clean = String(path ?? '').replaceAll('\\', '/');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('Invalid OPFS path');
    const fileName = parts.pop()!;
    const dir = await this.getDir(parts, create);
    return dir.getFileHandle(sanitizeSegment(fileName), { create });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.getFileHandle(path, false);
      return true;
    } catch {
      return false;
    }
  }

  async writeFile(path: string, data: Blob | ArrayBuffer | Uint8Array): Promise<void> {
    const handle = await this.getFileHandle(path, true);
    const writable = await handle.createWritable();
    try {
      if (data instanceof Blob) {
        await writable.write(data);
      } else if (data instanceof ArrayBuffer) {
        await writable.write(new Uint8Array(data));
      } else {
        await writable.write(data);
      }
    } finally {
      await writable.close();
    }
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.writeFile(path, textEncoder.encode(text));
  }

  async readFile(path: string): Promise<File> {
    const handle = await this.getFileHandle(path, false);
    return handle.getFile();
  }

  async readText(path: string): Promise<string> {
    const file = await this.readFile(path);
    const buf = await file.arrayBuffer();
    return textDecoder.decode(buf);
  }

  async readManifest(): Promise<AssetManifest> {
    try {
      const txt = await this.readText('manifest.json');
      const parsed = JSON.parse(txt) as AssetManifest;
      if (parsed && parsed.version === 1 && parsed.recordsByKey) return parsed;
      return defaultManifest();
    } catch {
      return defaultManifest();
    }
  }

  async writeManifest(next: AssetManifest): Promise<void> {
    await this.writeText('manifest.json', JSON.stringify(next));
  }

  async getOrCreateRecord(params: {
    key: string;
    kind: AssetManifestRecord['kind'];
    name?: string;
    mimeType?: string;
  }): Promise<AssetManifestRecord> {
    const now = Date.now();
    const manifest = await this.readManifest();
    const existing = manifest.recordsByKey[params.key];
    const next: AssetManifestRecord = existing
      ? {
          ...existing,
          kind: existing.kind ?? params.kind,
          name: existing.name ?? params.name,
          mimeType: existing.mimeType ?? params.mimeType,
          updatedAtMs: now,
        }
      : {
          key: params.key,
          kind: params.kind,
          raw: `raw/${params.key}/raw.bin`,
          createdAtMs: now,
          updatedAtMs: now,
          name: params.name,
          mimeType: params.mimeType,
        };

    manifest.recordsByKey[params.key] = next;
    await this.writeManifest(manifest);
    return next;
  }

  async updateRecord(key: string, patch: Partial<AssetManifestRecord>): Promise<AssetManifestRecord> {
    const now = Date.now();
    const manifest = await this.readManifest();
    const existing = manifest.recordsByKey[key];
    if (!existing) throw new Error(`Missing manifest record: ${key}`);
    const next = { ...existing, ...patch, updatedAtMs: now };
    manifest.recordsByKey[key] = next;
    await this.writeManifest(manifest);
    return next;
  }

  async ensureRawFromFile(record: AssetManifestRecord, file: File): Promise<void> {
    const exists = await this.exists(record.raw);
    if (exists) return;
    await this.writeFile(record.raw, file);
  }

  async ensureRawFromUrl(record: AssetManifestRecord, url: string): Promise<void> {
    const exists = await this.exists(record.raw);
    if (exists) return;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch raw asset (${resp.status}): ${url}`);
    const blob = await resp.blob();
    await this.writeFile(record.raw, blob);
  }

  async getReadableError(err: unknown): Promise<string> {
    return asErrorMessage(err);
  }
}

const opfsStore = new OpfsStore();
export default opfsStore;
