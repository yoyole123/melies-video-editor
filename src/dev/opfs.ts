type OpfsRoot = FileSystemDirectoryHandle;

type Maybe<T> = T | null | undefined;

const hasOpfs = () => {
  return typeof navigator !== 'undefined' && typeof (navigator as any).storage?.getDirectory === 'function';
};

export const ensureOpfsRoot = async (): Promise<OpfsRoot> => {
  if (!hasOpfs()) {
    throw new Error('OPFS not available in this browser (navigator.storage.getDirectory missing).');
  }
  return await (navigator as any).storage.getDirectory();
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
  for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    try {
      await dir.removeEntry((entry as any).name, { recursive: true });
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
  for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    if ((entry as any).kind === 'file') out.push(entry as FileSystemFileHandle);
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
