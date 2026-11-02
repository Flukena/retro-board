import { useEffect } from 'react';
import { resolveBoardShortcut } from './board-shortcuts.js';

const INTERACTIVE_SELECTOR = 'input, textarea, select, button, [contenteditable="true"], [role="dialog"], [data-board-shortcuts="off"]';

export function attachSpacePan(view, document, spaceHeldRef, canvasRef, interactionRef) {
  const updateCursor = () => {
    if (canvasRef.current) {
      canvasRef.current.style.cursor = interactionRef.current?.kind === 'pan' ? 'grabbing' : spaceHeldRef.current ? 'grab' : '';
    }
  };
  const release = () => { spaceHeldRef.current = false; updateCursor(); };
  const onKeyDown = event => {
    if (resolveBoardShortcut(event) !== 'pan' || event.target?.closest?.(INTERACTIVE_SELECTOR)
      || document.querySelector('[role="dialog"]')) return;
    event.preventDefault();
    spaceHeldRef.current = true;
    updateCursor();
  };
  const onKeyUp = event => { if (event.code === 'Space') release(); };
  view.addEventListener('keydown', onKeyDown);
  view.addEventListener('keyup', onKeyUp);
  view.addEventListener('blur', release);
  return () => {
    view.removeEventListener('keydown', onKeyDown);
    view.removeEventListener('keyup', onKeyUp);
    view.removeEventListener('blur', release);
  };
}

export function useSpacePan(spaceHeldRef, canvasRef, interactionRef) {
  useEffect(() => attachSpacePan(window, document, spaceHeldRef, canvasRef, interactionRef),
    [spaceHeldRef, canvasRef, interactionRef]);
}
