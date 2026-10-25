import { useRef } from 'react';
import { isMobileGestureEvent } from './mobile-gestures.js';

// On touch screens the first tap selects a card; tapping it again edits it.
export const TAP_MAX_MOVE_PX = 10;
export const TAP_MAX_DURATION_MS = 500;
const EDIT_POINTER_TYPES = new Set(['touch', 'pen']);
const TOUCH_POINTER_TYPE = 'touch';

export function tapEditsCard(down, up) {
  if (!down?.wasSelected || !EDIT_POINTER_TYPES.has(down.pointerType)) return false;
  const moved = Math.hypot(up.x - down.x, up.y - down.y);
  return moved <= TAP_MAX_MOVE_PX && up.time - down.time <= TAP_MAX_DURATION_MS;
}

/**
 * Touch input reaches cards only as the mouse events replayed by mobile-gestures:
 * mousedown on the card, mouseup on the window. Mouse clicks keep double-click editing.
 */
export function useTapToEdit({ selected, enabled }) {
  const stateRef = useRef({ selected, enabled });
  stateRef.current = { selected, enabled };
  return (event, onEdit) => {
    if (!isMobileGestureEvent(event)) return;
    const down = {
      pointerType: TOUCH_POINTER_TYPE, wasSelected: stateRef.current.selected,
      x: event.clientX, y: event.clientY, time: event.timeStamp,
    };
    event.view?.addEventListener('mouseup', (up) => {
      if (stateRef.current.enabled && tapEditsCard(down, { x: up.clientX, y: up.clientY, time: up.timeStamp })) onEdit();
    }, { once: true });
  };
}
