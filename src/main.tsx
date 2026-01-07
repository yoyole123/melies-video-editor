import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import HostApp from './dev/HostApp';
import DevRoot from './dev/DevRoot';

const normalizeVitePublicUrl = (url: string) => String(url ?? '').replace(/^\/public\//, '/');

const getDevFootageUrls = () => {
  // Dev-only convenience: load everything in public/footage into the footage bin.
  // This code only runs in the local dev harness, not in the published package entry.
  if (!import.meta.env.DEV) return undefined;

  const modules = import.meta.glob('../public/footage/**/*.{mp4,webm,mov,mp3,wav,m4a,aac,ogg}', {
    eager: true,
    query: '?url',
    import: 'default',
  });

  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, url]) => normalizeVitePublicUrl(String(url)));
};

const devFootageUrls = getDevFootageUrls();

const shouldUseDevHostApp = () => {
  if (!import.meta.env.DEV) return false;

  const value = String(import.meta.env.VITE_DEV_HOST_APP ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

const Root = shouldUseDevHostApp() ? HostApp : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {import.meta.env.DEV ? (
      <DevRoot defaultFootageUrls={devFootageUrls} useHostShell={shouldUseDevHostApp()} />
    ) : (
      <Root />
    )}
  </StrictMode>
);
