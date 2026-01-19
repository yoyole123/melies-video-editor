import { useMemo, useRef, useState } from 'react';
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
