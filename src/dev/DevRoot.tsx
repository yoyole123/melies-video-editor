import { useEffect, useMemo, useRef, useState } from 'react';
import HostApp from './HostApp';
import { MeliesVideoEditor } from '../lib';
import mediaCache from '../mediaCache';
import { clearDir, ensureOpfsRoot, getFileFromPublicUrl, listFiles, writeBlobToOpfs } from './opfs';

type Mode =
  | 'legacy-url'
  | 'legacy-blob'
  | 'legacy-opfs'
  | 'new-blob'
  | 'new-opfs-files'
  | 'new-opfs-handles';

type Source = 'samples' | 'upload';

const MODE_KEY = 'melies.dev.mode';
const SOURCE_KEY = 'melies.dev.source';

const normalizeVitePublicUrl = (url: string) => String(url ?? '').replace(/^\/public\//, '/');

const getExt = (name: string) => {
  const clean = String(name ?? '').split('#')[0].split('?')[0];
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return '';
  return clean.slice(dot + 1).toLowerCase();
};

const guessKindFromFile = (file: File) => {
  const t = String(file.type ?? '').toLowerCase();
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  const ext = getExt(file.name);
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
  return 'video';
};

export default function DevRoot({
  defaultFootageUrls,
  useHostShell,
}: {
  defaultFootageUrls?: string[];
  useHostShell: boolean;
}) {
  const initialMode = useMemo<Mode>(() => {
    const raw = String(localStorage.getItem(MODE_KEY) ?? '').trim();
    const ok = [
      'legacy-url',
      'legacy-blob',
      'legacy-opfs',
      'new-blob',
      'new-opfs-files',
      'new-opfs-handles',
    ] as const;
    return (ok.includes(raw as any) ? (raw as Mode) : 'new-opfs-files') as Mode;
  }, []);

  const initialSource = useMemo<Source>(() => {
    const raw = String(localStorage.getItem(SOURCE_KEY) ?? '').trim();
    return raw === 'upload' ? 'upload' : 'samples';
  }, []);

  const [mode, setMode] = useState<Mode>(initialMode);
  const [source, setSource] = useState<Source>(initialSource);
  const [status, setStatus] = useState<string>('');

  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);

  const [footageUrls, setFootageUrls] = useState<string[] | undefined>(undefined);
  const [footageFiles, setFootageFiles] = useState<File[] | undefined>(undefined);
  const [footageFileHandles, setFootageFileHandles] = useState<
    Array<{ getFile: () => Promise<File>; name?: string }> | undefined
  >(undefined);

  const blobUrlsToRevoke = useRef<string[]>([]);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(SOURCE_KEY, source);
  }, [source]);

  const sampleUrls = useMemo(() => {
    const urls = Array.isArray(defaultFootageUrls) ? defaultFootageUrls : [];
    return urls.map(normalizeVitePublicUrl);
  }, [defaultFootageUrls]);

  const loadSourceFiles = async (): Promise<File[]> => {
    if (source === 'upload') return uploadedFiles;

    const urls = sampleUrls;
    const out: File[] = [];
    for (const url of urls) {
      try {
        out.push(await getFileFromPublicUrl(url));
      } catch (err) {
        console.warn('[dev] failed to fetch sample', url, err);
      }
    }
    return out;
  };

  const clearBlobUrls = () => {
    const urls = blobUrlsToRevoke.current;
    blobUrlsToRevoke.current = [];
    for (const url of urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
  };

  const makeBlobUrlsFromFiles = (files: File[]): string[] => {
    clearBlobUrls();
    const urls: string[] = [];
    for (const file of files) {
      const url = URL.createObjectURL(file);
      urls.push(url);
      blobUrlsToRevoke.current.push(url);

      // Register metadata so audio works reliably for blob: sources.
      mediaCache.registerSrcMeta(url, { name: file.name, mimeType: file.type });
    }
    return urls;
  };

  const ensureOpfsForFiles = async (files: File[]): Promise<FileSystemFileHandle[]> => {
    const root = await ensureOpfsRoot();
    const dirPath = 'melies-dev-footage';

    // For uploads, always refresh OPFS to match the user selection.
    // For samples, reuse existing directory when possible.
    const shouldRefresh = source === 'upload';

    let handles = await listFiles({ root, dirPath });
    const existingNames = new Set(handles.map((h) => h.name));
    const expectedNames = new Set(files.map((f) => f.name));

    const hasSameNames =
      handles.length === files.length &&
      [...expectedNames].every((n) => existingNames.has(n));

    if (shouldRefresh || !hasSameNames) {
      await clearDir({ root, dirPath });
      for (const file of files) {
        await writeBlobToOpfs({ root, dirPath, fileName: file.name, blob: file });
      }
      handles = await listFiles({ root, dirPath });
    }

    return handles.sort((a, b) => a.name.localeCompare(b.name));
  };

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setStatus('Loading…');
      setFootageUrls(undefined);
      setFootageFiles(undefined);
      setFootageFileHandles(undefined);
      clearBlobUrls();

      try {
        // If user chose upload source but has no files yet, avoid an empty bin.
        if (source === 'upload' && uploadedFiles.length === 0) {
          setStatus('Select files to upload.');
          setFootageUrls(sampleUrls.length ? sampleUrls : undefined);
          return;
        }

        if (mode === 'legacy-url') {
          // Only meaningful for sample URLs.
          if (source === 'samples') {
            setFootageUrls(sampleUrls.length ? sampleUrls : undefined);
            setStatus('Legacy URL mode');
            return;
          }
          // Upload source cannot produce HTTP URLs; fall back.
          setStatus('Legacy URL mode does not support uploads; using Legacy Blob instead.');
          setMode('legacy-blob');
          return;
        }

        if (mode === 'legacy-blob') {
          const files = await loadSourceFiles();
          if (cancelled) return;
          const urls = makeBlobUrlsFromFiles(files);
          setFootageUrls(urls);
          setStatus('Legacy Blob (footageUrls=blob:...)');
          return;
        }

        if (mode === 'new-blob') {
          const files = await loadSourceFiles();
          if (cancelled) return;
          setFootageFiles(files);
          setStatus('New Files (footageFiles=File[])');
          return;
        }

        // OPFS modes
        const files = await loadSourceFiles();
        if (cancelled) return;

        const handles = await ensureOpfsForFiles(files);
        if (cancelled) return;

        if (mode === 'legacy-opfs') {
          const opfsFiles = await Promise.all(handles.map((h) => h.getFile()));
          if (cancelled) return;
          const urls = makeBlobUrlsFromFiles(opfsFiles);
          setFootageUrls(urls);
          setStatus('Legacy OPFS (OPFS → File → blob: → footageUrls)');
          return;
        }

        if (mode === 'new-opfs-handles') {
          setFootageFileHandles(
            handles.map((h) => ({
              getFile: () => h.getFile(),
              name: h.name,
            }))
          );
          setStatus('New OPFS Handles (footageFileHandles)');
          return;
        }

        // new-opfs-files
        const opfsFiles = await Promise.all(handles.map((h) => h.getFile()));
        if (cancelled) return;
        setFootageFiles(opfsFiles);
        setStatus('New OPFS Files (footageFiles from OPFS)');
      } catch (err) {
        console.warn('[dev] mode init failed', err);
        setStatus('Failed to initialize mode; falling back to sample URLs.');
        setFootageUrls(sampleUrls.length ? sampleUrls : undefined);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, source, uploadedFiles, sampleUrls.join('|')]);

  useEffect(() => {
    return () => {
      clearBlobUrls();
    };
  }, []);

  const EditorRoot = useHostShell ? HostApp : null;

  const editorProps = {
    footageUrls,
    footageFiles,
    footageFileHandles,
  };

  const isAudioDemo = useMemo(() => {
    const files = source === 'upload' ? uploadedFiles : [];
    return files.some((f) => guessKindFromFile(f) === 'audio');
  }, [source, uploadedFiles]);

  return (
    <div>
      <div style={{ padding: 8, borderBottom: '1px solid #ddd', display: 'flex', gap: 12, alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Source
          <select
            value={source}
            onChange={(e) => setSource(e.target.value === 'upload' ? 'upload' : 'samples')}
          >
            <option value="samples">Samples (public/footage)</option>
            <option value="upload">Upload (File input)</option>
          </select>
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="legacy-url">Legacy: URLs (footageUrls=http)</option>
            <option value="legacy-blob">Legacy: Blob (footageUrls=blob:)</option>
            <option value="legacy-opfs">Legacy: OPFS (OPFS → blob → footageUrls)</option>
            <option value="new-blob">New: Files (footageFiles=File[])</option>
            <option value="new-opfs-files">New: OPFS Files (OPFS → File[])</option>
            <option value="new-opfs-handles">New: OPFS Handles (OPFS → handles)</option>
          </select>
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Upload
          <input
            type="file"
            multiple
            accept="video/*,audio/*"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              setUploadedFiles(list);
            }}
          />
        </label>

        <div style={{ fontSize: 12, color: '#555' }}>{status}</div>
        {isAudioDemo ? <div style={{ fontSize: 12, color: '#555' }}>Audio: included</div> : null}
      </div>

      {useHostShell && EditorRoot ? (
        <EditorRoot {...editorProps} />
      ) : (
        <MeliesVideoEditor {...editorProps} />
      )}
    </div>
  );
}
