import { useEffect, useState } from 'react';

export function useCoarsePointer() {
  const getInitial = () => {
    if (typeof window === 'undefined') return false;
    return (
      typeof navigator !== 'undefined' &&
      // maxTouchPoints is the most reliable cross-browser hint.
      (navigator.maxTouchPoints ?? 0) > 0
    );
  };

  const [isCoarse, setIsCoarse] = useState(getInitial);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setIsCoarse(Boolean(mq.matches) || getInitial());

    update();

    // Safari < 14 uses addListener/removeListener.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }

    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  return isCoarse;
}
