import { useEffect, useRef, useState } from 'react';
import { hideDrawingImage } from './drawing-visibility.js';
import { loadDrawingImage } from './drawing-image.js';

export function useDrawingImage(active, target, onChange) {
  const baseRef = useRef(null), changeRef = useRef(onChange);
  changeRef.current = onChange;
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || !target) { setLoading(false); setFailed(false); return undefined; }
    const abort = new AbortController(); let asset = null, reveal = () => {};
    setLoading(true); setFailed(false);
    const loaded = value => {
      if (abort.signal.aborted) { value?.image.close(); return; }
      asset = value; baseRef.current = value; setLoading(false); setFailed(!value);
      if (value) {
        reveal = hideDrawingImage(document, target.id);
      }
      changeRef.current();
    };
    loadDrawingImage(target, { signal: abort.signal }).then(loaded, () => {
      if (!abort.signal.aborted) { setLoading(false); setFailed(true); }
    });
    return () => {
      abort.abort(); asset?.image.close(); baseRef.current = null;
      reveal();
    };
  }, [active, target, attempt]);
  return { baseRef, loading, failed, retry: () => setAttempt(value => value + 1) };
}
