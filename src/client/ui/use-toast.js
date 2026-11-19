import { useCallback, useEffect, useState } from 'react';

const TOAST_DISMISS_MS = 3200;

export function scheduleToastDismiss(toast, setToast, clock = { setTimeout, clearTimeout }) {
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
