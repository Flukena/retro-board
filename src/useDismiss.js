import { useEffect } from 'react';

const DISMISS_KEY = 'Escape';

export function subscribeDismiss(ref, onDismiss, target) {
  const onKeyDown = (event) => { if (event.key === DISMISS_KEY) onDismiss(); };
  const onPointerDown = (event) => { if (!ref.current?.contains(event.target)) onDismiss(); };
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('pointerdown', onPointerDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('pointerdown', onPointerDown);
  };
}

export function useDismiss(open, ref, onDismiss) {
  useEffect(() => {
    if (open) return subscribeDismiss(ref, onDismiss, document);
  }, [open, ref, onDismiss]);
}
