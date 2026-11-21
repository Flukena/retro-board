import { resolveBoardShortcut } from './board-shortcuts.js';

const outcome = (action = null, preventDefault = false) => ({ action, preventDefault });
const ZOOM_ACTIONS = new Set(['zoomIn', 'zoomOut', 'zoomReset']);
const FIT_ACTIONS = new Set(['fitContent', 'fitSelection']);
const SELECTION_ACTIONS = new Set(['copy', 'cut', 'duplicate']);
const PREVENTED_ACTIONS = new Set(['front', 'back', 'forward', 'backward', 'undo', 'redo', 'selectAll']);

function routeAction(action, event, state) {
  if (state.tools?.includes(action)) return event.repeat ? outcome() : outcome(action, true);
  if (FIT_ACTIONS.has(action)) return state.interacting ? outcome() : outcome(action, true);
  if (ZOOM_ACTIONS.has(action)) return outcome(state.interacting ? null : action, true);
  if (PREVENTED_ACTIONS.has(action)) return outcome(action, true);
  return routeSelectionAction(action, state);
}

function routeSelectionAction(action, state) {
  if (action === 'cancel') return outcome(state.creating ? 'cancelCreation' : 'clearSelection');
  if (action === 'delete') return outcome(state.selected ? action : null);
  if (SELECTION_ACTIONS.has(action)) return state.selected ? outcome(action, true) : outcome();
  if (action === 'paste' && state.clipboard) return outcome(action, true);
  return outcome();
}

/** Ordered board-key policy; DOM reads and all action effects stay in the binding. */
export function routeBoardKey(event, state) {
  if (state.focusedText || state.nameModal) return outcome();
  if (state.commentsOpen) return event.key === 'Escape' ? outcome('closeComments', true) : outcome();
  if (state.targetBlocked) return outcome();
  if (event.key === 'Escape' && state.following) return outcome('stopFollowing', true);
  if (state.dialogOpen) return outcome();
  return routeAction(resolveBoardShortcut(event), event, state);
}
