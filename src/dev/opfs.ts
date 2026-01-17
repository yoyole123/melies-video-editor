type OpfsRoot = FileSystemDirectoryHandle;

type Maybe<T> = T | null | undefined;

type StorageWithGetDirectory = {
  getDirectory?: () => Promise<OpfsRoot>;
};

type DirectoryIterable = {
  values?: () => AsyncIterable<FileSystemHandle>;
  entries?: () => AsyncIterable<[string, FileSystemHandle]>;
};

/**
 * Iterate directory entries with best-effort typing.
 *
 * Some TS/lib.dom versions don't type `FileSystemDirectoryHandle.values()` yet.
 */
const iterateDirectoryHandles = (dir: FileSystemDirectoryHandle): AsyncIterable<FileSystemHandle> => {
  const maybeIterable = dir as unknown as DirectoryIterable;
  if (typeof maybeIterable.values === 'function') return maybeIterable.values();

  if (typeof maybeIterable.entries === 'function') {
    const entries = maybeIterable.entries;
    async function* toValues() {
      for await (const [, handle] of entries.call(dir)) yield handle;
    }
    return toValues();
  }

  throw new Error('Directory iteration not supported in this browser.');
};

export type OpfsSupport = {
  supported: boolean;
  reason?: string;
};

/**
 * Best-effort OPFS capability check.
 *
 * Notes:
 * - Many browsers require a secure context (HTTPS); desktop browsers often treat localhost as secure.
 * - Some mobile browsers may not implement OPFS at all.
 */
export const getOpfsSupport = (): OpfsSupport => {
  const storage = (typeof navigator !== 'undefined' ? (navigator.storage as unknown as StorageWithGetDirectory) : null);
  const hasApi = Boolean(storage && typeof storage.getDirectory === 'function');
  if (!hasApi) return { supported: false, reason: 'navigator.storage.getDirectory missing' };

  const isSecure = typeof isSecureContext === 'boolean' ? isSecureContext : true;
  if (!isSecure) return { supported: false, reason: 'requires a secure context (HTTPS)' };

  return { supported: true };
};

export const ensureOpfsRoot = async (): Promise<OpfsRoot> => {
  const support = getOpfsSupport();
  if (!support.supported) {
    throw new Error(`OPFS not available: ${support.reason ?? 'unsupported'}.`);
  }
  const storage = navigator.storage as unknown as StorageWithGetDirectory;
  if (typeof storage.getDirectory !== 'function') {
    throw new Error('OPFS not available: navigator.storage.getDirectory missing.');
  }
  return await storage.getDirectory();
};

export const ensureDir = async (root: OpfsRoot, path: string): Promise<FileSystemDirectoryHandle> => {
  const parts = String(path)
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

  let dir: FileSystemDirectoryHandle = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
};

export const writeBlobToOpfs = async (opts: {
  root: OpfsRoot;
  dirPath: string;
  fileName: string;
  blob: Blob;
}): Promise<{ fileHandle: FileSystemFileHandle; path: string }> => {
  const dir = await ensureDir(opts.root, opts.dirPath);
  const fileHandle = await dir.getFileHandle(opts.fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(opts.blob);
  await writable.close();

  const path = `${opts.dirPath.replace(/\/+$/g, '')}/${opts.fileName}`.replace(/^\//, '');
  return { fileHandle, path };
};

export const clearDir = async (opts: {
  root: OpfsRoot;
  dirPath: string;
}): Promise<void> => {
  const dir = await ensureDir(opts.root, opts.dirPath);
  for await (const entry of iterateDirectoryHandles(dir)) {
    try {
      await dir.removeEntry(entry.name, { recursive: true });
    } catch {
      // ignore
    }
  }
};

export const listFiles = async (opts: {
  root: OpfsRoot;
  dirPath: string;
}): Promise<FileSystemFileHandle[]> => {
  const dir = await ensureDir(opts.root, opts.dirPath);
  const out: FileSystemFileHandle[] = [];
  for await (const entry of iterateDirectoryHandles(dir)) {
    if (entry.kind === 'file') out.push(entry as FileSystemFileHandle);
  }
  return out;
};

export const getFileFromPublicUrl = async (url: string, fallbackName?: Maybe<string>): Promise<File> => {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const blob = await resp.blob();
  const rawName = fallbackName || url.split('/').pop() || 'asset';
  const name = String(rawName).split('#')[0].split('?')[0] || 'asset';
  const type = blob.type || undefined;
  return new File([blob], name, type ? { type } : undefined);
};
