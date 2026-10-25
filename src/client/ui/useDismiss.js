import { useEffect } from 'react';

const DISMISS_KEY = 'Escape';

export function subscribeDismiss(ref, onDismiss, target, additionalRef) {
  const onKeyDown = (event) => { if (event.key === DISMISS_KEY) onDismiss(); };
  const onPointerDown = (event) => { if (!ref.current?.contains(event.target) && !additionalRef?.current?.contains(event.target)) onDismiss(); };
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('pointerdown', onPointerDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('pointerdown', onPointerDown);
  };
}

export function useDismiss(open, ref, onDismiss, additionalRef) {
  useEffect(() => {
    if (open) return subscribeDismiss(ref, onDismiss, document, additionalRef);
  }, [open, ref, onDismiss, additionalRef]);
}
