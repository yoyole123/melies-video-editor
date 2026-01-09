import { useEffect } from 'react';

export function AssetLoader({
  onComplete,
}: {
  onComplete: (assets: { src: string; name: string }[]) => void;
}) {
  // This component existed in older dev flows that pre-registered blob URLs.
  // The editor now has its own OPFS + proxy preparation pipeline.
  useEffect(() => {
    onComplete([]);
  }, [onComplete]);

  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 12, color: '#555' }}>
        Proxy-flow loader is no longer required. Use the editor’s built-in media preparation.
      </div>
    </div>
  );
}
