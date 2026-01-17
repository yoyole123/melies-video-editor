import { useEffect, useMemo, useState } from 'react';
import HostApp from './HostApp';
import { MeliesVideoEditor } from '../lib';
import { clearDir, ensureOpfsRoot, getFileFromPublicUrl, getOpfsSupport, listFiles, writeBlobToOpfs } from './opfs';

import './devRoot.css';

type Source = 'samples' | 'upload';

const SOURCE_KEY = 'melies.dev.source';

/** Normalize URLs so dev sample paths work whether provided as /public/* or /* in Vite. */
const normalizeVitePublicUrl = (url: string) => String(url ?? '').replace(/^\/public\//, '/');

/** Get a lowercase file extension (no dot). */
const getExt = (name: string) => {
  const clean = String(name ?? '').split('#')[0].split('?')[0];
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return '';
  return clean.slice(dot + 1).toLowerCase();
};

/** Best-effort audio vs video detection for showing a small UI hint. */
const guessKindFromFile = (file: File) => {
  const t = String(file.type ?? '').toLowerCase();
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  const ext = getExt(file.name);
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
  return 'video';
};

/** Extract a human-readable error message from an unknown throw value. */
const getErrorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

export default function DevRoot({
  defaultFootageUrls,
  useHostShell,
}: {
  defaultFootageUrls?: string[];
  useHostShell: boolean;
}) {
  const initialSource = useMemo<Source>(() => {
    const raw = String(localStorage.getItem(SOURCE_KEY) ?? '').trim();
    return raw === 'upload' ? 'upload' : 'samples';
  }, []);

  const [source, setSource] = useState<Source>(initialSource);
  const [status, setStatus] = useState<string>('');

  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);

  const [footageFiles, setFootageFiles] = useState<File[] | undefined>(undefined);

  useEffect(() => {
    localStorage.setItem(SOURCE_KEY, source);
  }, [source]);

  const sampleUrls = useMemo(() => {
    const urls = Array.isArray(defaultFootageUrls) ? defaultFootageUrls : [];
    return urls.map(normalizeVitePublicUrl);
  }, [defaultFootageUrls]);

  /**
   * Load sample files from `public/` by fetching them as Blob and wrapping into File.
   */
  const loadSampleFiles = async (): Promise<File[]> => {
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

  /**
   * Ensure OPFS contains the provided files, returning handles in a stable order.
   * When `refresh` is true, OPFS is cleared and rewritten to match exactly.
   */
  const ensureOpfsForFiles = async (files: File[], refresh: boolean): Promise<FileSystemFileHandle[]> => {
    const root = await ensureOpfsRoot();
    const dirPath = 'melies-dev-footage';

    let handles = await listFiles({ root, dirPath });
    const existingNames = new Set(handles.map((h) => h.name));
    const expectedNames = new Set(files.map((f) => f.name));

    const hasSameNames =
      handles.length === files.length &&
      [...expectedNames].every((n) => existingNames.has(n));

    if (refresh || !hasSameNames) {
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
      setFootageFiles(undefined);

      try {
        // Single supported dev mode: New OPFS Files (OPFS → File[]).
        // If user chose upload source but has no files yet, avoid an empty bin by showing samples.
        const usingSamplesFallback = source === 'upload' && uploadedFiles.length === 0;
        const files = usingSamplesFallback
          ? await loadSampleFiles()
          : source === 'upload'
            ? uploadedFiles
            : await loadSampleFiles();
        if (cancelled) return;

        if (!files.length) {
          setStatus('No footage files found.');
          setFootageFiles(undefined);
          return;
        }

        if (usingSamplesFallback) {
          setStatus('Select files to upload (showing Samples for now).');
        }

        // Mobile / HTTP local testing: OPFS may be unavailable (secure-context restriction or lack of support).
        // When unavailable, fall back to passing direct File[] so uploads still work.
        const opfsSupport = getOpfsSupport();
        if (!opfsSupport.supported) {
          setFootageFiles(files);
          const base = usingSamplesFallback
            ? 'Select files to upload (showing Samples for now).'
            : 'New: Files (direct File[])';
          setStatus(`${base} — OPFS unavailable: ${opfsSupport.reason ?? 'unsupported'}.`);
          return;
        }

        const shouldRefreshOpfs = source === 'upload' && !usingSamplesFallback;
        let handles: FileSystemFileHandle[];
        try {
          handles = await ensureOpfsForFiles(files, shouldRefreshOpfs);
        } catch (opfsErr) {
          // OPFS is nominally supported but failed at runtime; keep dev flow usable.
          setFootageFiles(files);
          const base = usingSamplesFallback
            ? 'Select files to upload (showing Samples for now).'
            : 'New: Files (direct File[])';
          setStatus(`${base} — OPFS failed: ${getErrorMessage(opfsErr)}.`);
          return;
        }
        if (cancelled) return;

        const opfsFiles = await Promise.all(handles.map((h) => h.getFile()));
        if (cancelled) return;
        setFootageFiles(opfsFiles);

        if (!usingSamplesFallback) {
          setStatus('New: OPFS Files (OPFS → File[])');
        }
      } catch (err) {
        console.warn('[dev] mode init failed', err);
        setStatus(`Failed to initialize dev footage (${getErrorMessage(err)}).`);
        setFootageFiles(undefined);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, uploadedFiles, sampleUrls.join('|')]);

  const EditorRoot = useHostShell ? HostApp : null;

  const editorProps = {
    footageFiles,
  };

  const isAudioDemo = useMemo(() => {
    const files = source === 'upload' ? uploadedFiles : [];
    return files.some((f) => guessKindFromFile(f) === 'audio');
  }, [source, uploadedFiles]);

  return (
    <div className="dev-root">
      <div className="dev-toolbar">
        <label className="dev-field">
          <span className="dev-label">Source</span>
          <select
            className="dev-control"
            value={source}
            onChange={(e) => setSource(e.target.value === 'upload' ? 'upload' : 'samples')}
          >
            <option value="samples">Samples</option>
            <option value="upload">Upload</option>
          </select>
        </label>

        <div className="dev-field" aria-label="Mode">
          <span className="dev-label">Mode</span>
          <span className="dev-badge">New: OPFS Files (OPFS → File[])</span>
        </div>

        <label className="dev-field dev-upload">
          <span className="dev-label">Upload</span>
          <input
            className="dev-control"
            type="file"
            multiple
            accept="video/*,audio/*"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              setUploadedFiles(list);
            }}
          />
        </label>

        <div className="dev-status" title={status}>
          {status}
          {isAudioDemo ? <span className="dev-audio">Audio: included</span> : null}
        </div>
      </div>

      <div className="dev-editor">
        {useHostShell && EditorRoot ? <EditorRoot {...editorProps} /> : <MeliesVideoEditor {...editorProps} />}
      </div>
    </div>
  );
}
