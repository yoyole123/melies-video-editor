import { useMemo, useState } from 'react';
import { MeliesVideoEditor } from '../lib';

export default function HostApp({ footageUrls }: { footageUrls?: string[] }) {
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
          <MeliesVideoEditor footageUrls={footageUrls} />
        </main>
      </div>
    </div>
  );
}
