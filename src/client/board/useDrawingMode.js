import { useCallback, useRef, useState } from 'react';

const DRAW_MODE = 'draw';
export function useDrawingMode() {
  const [mode, updateMode] = useState(null);
  const modeRef = useRef(mode), exitRef = useRef(null), requestRef = useRef(0);
  const setMode = useCallback(next => {
    const value = typeof next === 'function' ? next(modeRef.current) : next;
    const commit = () => { modeRef.current = value; updateMode(value); };
    if (modeRef.current !== DRAW_MODE || value === DRAW_MODE || !exitRef.current) { commit(); return; }
    const request = ++requestRef.current;
    void exitRef.current().then(saved => { if (saved && request === requestRef.current) commit(); });
  }, []);
  return [mode, setMode, exitRef];
}
