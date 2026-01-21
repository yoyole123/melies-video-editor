import { useMemo, useRef, useState, useEffect } from 'react';
import { MeliesVideoEditor } from '../lib';
import type { MeliesVideoEditorRef } from '../lib';

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

  return (
    <div className="dev-host">
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
          />
        </main>
      </div>
    </div>
  );
}
