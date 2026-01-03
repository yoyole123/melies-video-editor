import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

const getDevFootageUrls = () => {
  // Dev-only convenience: load everything in public/footage into the footage bin.
  // This code only runs in the local dev harness, not in the published package entry.
  if (!import.meta.env.DEV) return undefined;

  const modules = import.meta.glob('../public/footage/**/*.{mp4,webm,mov,mp3,wav,m4a,aac,ogg}', {
    eager: true,
    as: 'url',
  });

  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, url]) => String(url));
};

const devFootageUrls = getDevFootageUrls();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App footageUrls={devFootageUrls} />
  </StrictMode>
);
