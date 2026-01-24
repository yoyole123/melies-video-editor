import { useMemo, useRef, useState, useEffect } from 'react';
import { MeliesVideoEditor } from '../lib';
import type { MeliesFootageImportEvent, MeliesTimelineSnapshot, MeliesVideoEditorRef } from '../lib';

const DOWNLOAD_MIME = 'application/json; charset=utf-8';

/**
 * Download a string as a file using a temporary object URL.
 * This is intentionally self-contained for the dev host.
 */
const downloadTextFile = (filename: string, content: string, mimeType = DOWNLOAD_MIME) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke after a tick so the download can start reliably.
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }
};

const safeTimestamp = () => {
  // Avoid ':' which is awkward on Windows filenames.
  return new Date().toISOString().replace(/[:.]/g, '-');
};

/**
 * Parse and validate a Melies timeline snapshot JSON payload.
 *
 * Keeps validation light on purpose: this is a dev host helper meant to
 * reproduce restore flows rather than enforce strict schema.
 */
const parseTimelineSnapshotJson = (rawJson: string) => {
  const parsed = JSON.parse(rawJson) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('Snapshot JSON must be an object.');

  const obj = parsed as Record<string, unknown>;
  const version = Number(obj.version);
  if (version !== 1) {
    throw new Error(`Unsupported snapshot version: ${String(obj.version)} (expected 1).`);
  }

  if (!Array.isArray(obj.editorData)) {
    throw new Error('Invalid snapshot: editorData must be an array.');
  }

  return parsed as MeliesTimelineSnapshot;
};

export default function HostApp({
  footageUrls,
  footageFiles,
  footageFileHandles,
}: {
  footageUrls?: string[];
  footageFiles?: File[];
  footageFileHandles?: Array<{ getFile: () => Promise<File>; name?: string }>;
}) {
  const editorRef = useRef<MeliesVideoEditorRef | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [note, setNote] = useState('');
  const [clicks, setClicks] = useState(0);

  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    const addLog = (prefix: string, args: any[]) => {
      try {
        const msg = args
          .map((a) => {
            if (typeof a === 'object') {
              try {
                return JSON.stringify(a);
              } catch {
                return '[Obj]';
              }
            }
            return String(a);
          })
          .join(' ');
        setLogs((prev) => [`[${prefix}] ${msg}`, ...prev].slice(0, 50));
      } catch {
        // ignore log errors
      }
    };

    console.log = (...args) => {
      originalLog(...args);
      addLog('LOG', args);
    };
    console.warn = (...args) => {
      originalWarn(...args);
      addLog('WARN', args);
    };
    console.error = (...args) => {
      originalError(...args);
      addLog('ERR', args);
    };

    return () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    };
  }, []);

  const appTitle = useMemo(() => 'Dev Host App', []);

  /** Dev-only: prove the imported-footage API works end-to-end. */
  const handleFootageImported = (event: MeliesFootageImportEvent) => {
    console.log('[HostApp] onFootageImported: files=', event.files.length, 'items=', event.items.length);

    const first = event.entries[0];
    if (first) {
      console.log('[HostApp] first import item', {
        id: first.item.id,
        name: first.item.name,
        kind: first.item.kind,
        srcPrefix: String(first.item.src).slice(0, 16),
      });
      console.log('[HostApp] first import file', {
        name: first.file.name,
        size: first.file.size,
        type: first.file.type,
        lastModified: first.file.lastModified,
      });

      const lookedUp = editorRef.current?.getImportedFileByFootageId(first.item.id) ?? null;
      console.log('[HostApp] ref lookup match?', {
        found: Boolean(lookedUp),
        sameName: lookedUp ? lookedUp.name === first.file.name : false,
        sameSize: lookedUp ? lookedUp.size === first.file.size : false,
      });
    }

    const all = editorRef.current?.listImportedFiles() ?? [];
    console.log(
      '[HostApp] listImportedFiles',
      all.map((x) => ({ footageId: x.footageId, name: x.file.name, size: x.file.size }))
    );
  };

  /**
   * Dev-only: import a previously downloaded snapshot JSON file.
   * Applies it via the editor ref to exercise the same restore code path.
   */
  const handleImportSnapshotFile = async (file: File | null) => {
    if (!file) return;
    try {
      const raw = await file.text();
      const snapshot = parseTimelineSnapshotJson(raw);

      if (!editorRef.current?.setTimelineSnapshot) {
        throw new Error('Editor ref not ready yet.');
      }

      editorRef.current.setTimelineSnapshot(snapshot);
      console.log('[HostApp] Imported timeline snapshot', {
        name: file.name,
        size: file.size,
        version: snapshot.version,
        rows: Array.isArray(snapshot.editorData) ? snapshot.editorData.length : 0,
      });
    } catch (err) {
      console.warn('[HostApp] Failed to import timeline snapshot', err);
    } finally {
      // Allow re-importing the same file by clearing the input value.
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  return (
    <div className="dev-host">
      <style>{`.dev-host button{color:#fff} .dev-host button[disabled]{opacity:0.65}`}</style>
      <header className="dev-host__header">
        <div className="dev-host__title">{appTitle}</div>
        <div className="dev-host__headerActions">
          <button type="button" onClick={() => setClicks((c) => c + 1)}>
            Clicks: {clicks}
          </button>
          <button
            type="button"
            onClick={() => {
              const snap = editorRef.current?.getTimelineSnapshot();
              if (!snap) return;
              const json = JSON.stringify(snap, null, 2);
              downloadTextFile(`melies-timeline-snapshot-${safeTimestamp()}.json`, json);
            }}
          >
            Download timeline state
          </button>

          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files && e.target.files.length ? e.target.files[0] : null;
              void handleImportSnapshotFile(file);
            }}
          />

          <button
            type="button"
            onClick={() => {
              importInputRef.current?.click();
            }}
          >
            Import timeline state
          </button>
        </div>
      </header>

      <div className="dev-host__body">
        <aside className="dev-host__sidebar">
          <div className="dev-host__sidebarSection">
            <div className="dev-host__sidebarLabel">Sidebar</div>
            <div className="dev-host__sidebarHelp">Simulates other app UI around the editor.</div>
          </div>

          <div className="dev-host__sidebarSection">
            <label className="dev-host__sidebarLabel" htmlFor="dev-note">
              Note
            </label>
            <textarea
              id="dev-note"
              className="dev-host__textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Type here to test focus/keyboard interactions…"
              rows={6}
            />
          </div>

          <div className="dev-host__sidebarSection">
            <div className="dev-host__sidebarLabel">Debug Console</div>
            <div
              style={{
                height: 200,
                overflow: 'auto',
                background: '#333',
                color: '#eee',
                fontSize: 10,
                padding: 4,
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
              }}
            >
              {logs.map((L, i) => (
                <div key={i} style={{ borderBottom: '1px solid #444', marginBottom: 2 }}>
                  {L}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#aaa' }}>
              Is Mobile: {String(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent))}
            </div>
          </div>
        </aside>

        <main className="dev-host__main">
          <MeliesVideoEditor
            ref={editorRef}
            footageUrls={footageUrls}
            footageFiles={footageFiles}
            footageFileHandles={footageFileHandles}
            onFootageImported={handleFootageImported}
            onExport={(e) => console.log("Export event", e)}
          />
        </main>
      </div>
    </div>
  );
}