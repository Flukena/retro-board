import { useCallback, useEffect, useState } from 'react';

const TOAST_DISMISS_MS = 3200;
const DEFAULT_TOAST_CLOCK = Object.freeze({
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
});

export function scheduleToastDismiss(toast, setToast, clock = DEFAULT_TOAST_CLOCK) {
  if (!toast || toast.sticky) return undefined;
  const timer = clock.setTimeout(() => setToast(null), TOAST_DISMISS_MS);
  return () => clock.clearTimeout(timer);
}

export function useToast() {
  const [toast, setToastRaw] = useState(null);
  const setToast = useCallback((next) => {
    setToastRaw(next ? { ...next, t: Date.now() } : null);
  }, []);
  useEffect(() => scheduleToastDismiss(toast, setToast), [toast]);
  return [toast, setToast];
}
