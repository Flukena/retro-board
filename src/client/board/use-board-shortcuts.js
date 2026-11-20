import { useEffect } from 'react';
import { routeBoardKey as routeKey } from './board-key-router.js';
import { ZOOM_STEP_FACTOR as ZOOM_FACTOR } from '../../domain/viewport-zoom.js';
import { t as translate } from '../ui/i18n.js';

const BLOCKED_TARGETS = 'input, textarea, select, [contenteditable="true"], [role="dialog"], [data-board-shortcuts="off"]';

function routingState(event, state, document, Element) {
  return {
    focusedText: state.focusedTextIdRef.current, nameModal: state.nameModalOpen, commentsOpen: state.commentsOpenReadable,
    get targetBlocked() {
      const element = event.target instanceof Element ? event.target : null;
      return !!element?.closest(BLOCKED_TARGETS);
    },
    following: state.followedUserIdRef.current,
    get dialogOpen() { return !!document.querySelector('[role="dialog"]'); },
    tools: Object.keys(state.shortcutToolHandlersRef.current), interacting: state.interactionRef.current !== null,
    creating: state.creationModeRef.current, selected: state.selectedIds.size > 0, clipboard: state.clipboardRef.current?.length > 0,
  };
}

function copySelection(state, commands, translate, cut) {
  if (!state.selectedIds.size) return;
  const picked = state.boardRef.current.items.filter(item => state.selectedIds.has(item.id));
  if (cut && !commands.deleteItemsIfAllowed(picked.map(item => item.id))) return;
  state.clipboardRef.current = picked.map(item => ({ ...item }));
  commands.setToast({ msg: translate('copy.done', { n: picked.length }), type: 'info' });
}

function selectionHandlers(state, commands, translate) {
  return {
    clearSelection: () => commands.setSelectedIds(new Set()),
    delete: () => { if (state.selectedIds.size) commands.deleteItemsIfAllowed(state.selectedIds); },
    copy: () => copySelection(state, commands, translate, false),
    cut: () => copySelection(state, commands, translate, true),
    paste: () => { if (state.clipboardRef.current?.length) commands.duplicateItems(state.clipboardRef.current); },
    duplicate: () => {
      if (!state.selectedIds.size) return;
      commands.duplicateItems(state.boardRef.current.items.filter(item => state.selectedIds.has(item.id)));
    },
    selectAll: () => commands.setSelectedIds(new Set(state.boardRef.current.items.map(item => item.id))),
  };
}

function actionHandlers(state, commands, translate, zoomFactor) {
  const singleId = () => state.selectedIds.size === 1 ? [...state.selectedIds][0] : null;
  return {
    ...selectionHandlers(state, commands, translate),
    fitContent: () => commands.fitToContent(),
    fitSelection: () => commands.fitToSelection(),
    zoomIn: () => commands.zoomBy(zoomFactor),
    zoomOut: () => commands.zoomBy(1 / zoomFactor),
    zoomReset: () => commands.resetZoom(),
    front: () => commands.bringToFront(state.selectedIds),
    back: () => commands.sendToBack(state.selectedIds),
    forward: () => commands.bringForward(singleId()),
    backward: () => commands.sendBackward(singleId()),
    cancelCreation: () => { commands.setCreationMode(null); commands.setZonePreview(null); },
    undo: () => commands.doUndo(),
    redo: () => commands.doRedo(),
  };
}

export function createBoardShortcuts({ state, commands, view = globalThis.window, document = globalThis.document,
  Element = globalThis.Element, routeBoardKey = routeKey, t = translate, ZOOM_STEP_FACTOR = ZOOM_FACTOR }) {
  const handlers = actionHandlers(state, commands, t, ZOOM_STEP_FACTOR);
  const onKey = event => {
    const { action, preventDefault } = routeBoardKey(event, routingState(event, state, document, Element));
    if (preventDefault) event.preventDefault();
    if (!action) return;
    if (action === 'closeComments') { commands.setCommentsOpenFor(null); return; }
    if (action === 'stopFollowing') { commands.stopFollowing(); return; }
    if (state.shortcutToolHandlersRef.current[action]) { state.shortcutToolHandlersRef.current[action](); return; }
    handlers[action]?.();
  };
  view.addEventListener('keydown', onKey);
  return { dispose: () => view.removeEventListener('keydown', onKey) };
}

export function useBoardShortcuts(options, dependencies) {
  useEffect(() => {
    const shortcuts = createBoardShortcuts(options);
    return () => shortcuts.dispose();
  }, dependencies);
}
