import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardShortcuts } from './use-board-shortcuts.js';
import { routeBoardKey } from './board-key-router.js';
import { ZOOM_STEP_FACTOR } from '../../domain/viewport-zoom.js';

class Target { constructor(blocked = false) { this.blocked = blocked; } closest() { return this.blocked; } }
function harness(initial = {}) {
  const calls = []; const listeners = new Map(); let dialog = false; let canDelete = true;
  const state = { focusedTextIdRef: { current: null }, nameModalOpen: false, commentsOpenReadable: false,
    followedUserIdRef: { current: null }, shortcutToolHandlersRef: { current: { stickyTool: () => calls.push(['tool']) } },
    interactionRef: { current: null }, creationModeRef: { current: null }, selectedIds: new Set(['card']),
    clipboardRef: { current: null }, boardRef: { current: { items: [{ id: 'card', text: 'hello' }, { id: 'other' }] } }, ...initial };
  const commands = Object.fromEntries(['setCommentsOpenFor', 'stopFollowing', 'fitToContent', 'fitToSelection', 'zoomBy', 'resetZoom',
    'bringToFront', 'sendToBack', 'bringForward', 'sendBackward', 'setCreationMode', 'setZonePreview', 'setSelectedIds', 'doUndo', 'doRedo',
    'duplicateItems', 'setToast'].map(name => [name, (...args) => calls.push([name, ...args])]));
  commands.deleteItemsIfAllowed = ids => { calls.push(['delete', [...ids]]); return canDelete; };
  const view = { addEventListener(name, handler) { assert.equal(this, view); listeners.set(name, handler); },
    removeEventListener(name, handler) { assert.equal(this, view); assert.equal(listeners.get(name), handler); listeners.delete(name); } };
  const controller = createBoardShortcuts({ state, commands, view, document: { querySelector: () => dialog }, Element: Target,
    routeBoardKey, t: (key, args) => ({ key, ...args }), ZOOM_STEP_FACTOR });
  const key = (key, modifiers = {}) => listeners.get('keydown')?.({ key, target: new Target(), ctrlKey: false, metaKey: false,
    shiftKey: false, altKey: false, repeat: false, preventDefault: () => calls.push(['prevent']), ...modifiers });
  return { calls, state, commands, controller, listeners, key, dialog: value => { dialog = value; }, allowDelete: value => { canDelete = value; } };
}

test('shortcut binding preserves input/modal/focus guard precedence and Escape behavior', () => {
  const h = harness(); h.state.focusedTextIdRef.current = 'card:body'; h.key('z', { ctrlKey: true }); assert.deepEqual(h.calls, []);
  const comments = harness({ commentsOpenReadable: true }); comments.key('Escape');
  assert.deepEqual(comments.calls, [['prevent'], ['setCommentsOpenFor', null]]); comments.controller.dispose();
  h.state.focusedTextIdRef.current = null; h.calls.length = 0;
  h.key('z', { ctrlKey: true, target: new Target(true) }); assert.deepEqual(h.calls, []);
  h.state.followedUserIdRef.current = 'peer'; h.dialog(true); h.key('Escape');
  assert.deepEqual(h.calls, [['prevent'], ['stopFollowing']]); h.controller.dispose(); assert.equal(h.listeners.size, 0);
});

test('copy/cut preserve snapshot copies and denied cut leaves clipboard untouched', () => {
  const h = harness(); h.key('c', { ctrlKey: true });
  assert.deepEqual(h.state.clipboardRef.current, [{ id: 'card', text: 'hello' }]);
  assert.notEqual(h.state.clipboardRef.current[0], h.state.boardRef.current.items[0]);
  h.state.clipboardRef.current = null; h.allowDelete(false); h.calls.length = 0; h.key('x', { ctrlKey: true });
  assert.equal(h.state.clipboardRef.current, null); assert.deepEqual(h.calls, [['prevent'], ['delete', ['card']]]);
  h.allowDelete(true); h.calls.length = 0; h.key('x', { ctrlKey: true });
  assert.equal(h.calls[1][0], 'delete'); assert.equal(h.calls[2][0], 'setToast');
});

test('undo/redo, paste, duplicate, select all and delete dispatch exact commands', () => {
  const h = harness(); h.key('z', { ctrlKey: true }); h.key('z', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(h.calls, [['prevent'], ['doUndo'], ['prevent'], ['doRedo']]);
  h.calls.length = 0; h.state.clipboardRef.current = [{ id: 'saved' }]; h.key('v', { ctrlKey: true });
  assert.deepEqual(h.calls, [['prevent'], ['duplicateItems', [{ id: 'saved' }]]]);
  h.calls.length = 0; h.key('d', { ctrlKey: true }); assert.deepEqual(h.calls[1], ['duplicateItems', [{ id: 'card', text: 'hello' }]]);
  h.calls.length = 0; h.key('a', { ctrlKey: true }); assert.deepEqual(h.calls, [['prevent'], ['setSelectedIds', new Set(['card', 'other'])]]);
  h.calls.length = 0; h.key('Delete'); assert.deepEqual(h.calls, [['delete', ['card']]]);
});

test('creation Escape clears mode and preview; selection Escape clears selection', () => {
  const h = harness(); h.state.creationModeRef.current = 'zone'; h.key('Escape');
  assert.deepEqual(h.calls, [['setCreationMode', null], ['setZonePreview', null]]);
  h.state.creationModeRef.current = null; h.calls.length = 0; h.key('Escape');
  assert.deepEqual(h.calls, [['setSelectedIds', new Set()]]);
});

test('tools, framing, zoom and z-order retain their command arguments and interaction guards', () => {
  const h = harness(); h.key('s'); assert.deepEqual(h.calls, [['prevent'], ['tool']]);
  h.calls.length = 0; h.key('1', { code: 'Digit1', shiftKey: true }); h.key('2', { code: 'Digit2', shiftKey: true });
  h.key('+', { code: 'Equal', ctrlKey: true }); h.key('-', { code: 'Minus', ctrlKey: true }); h.key('0', { code: 'Digit0', ctrlKey: true });
  assert.deepEqual(h.calls, [['prevent'], ['fitToContent'], ['prevent'], ['fitToSelection'], ['prevent'], ['zoomBy', ZOOM_STEP_FACTOR],
    ['prevent'], ['zoomBy', 1 / ZOOM_STEP_FACTOR], ['prevent'], ['resetZoom']]);
  h.calls.length = 0; h.key(']', { code: 'BracketRight' }); h.key('[', { code: 'BracketLeft' });
  h.key(']', { code: 'BracketRight', ctrlKey: true }); h.key('[', { code: 'BracketLeft', ctrlKey: true });
  assert.deepEqual(h.calls, [['prevent'], ['bringToFront', new Set(['card'])], ['prevent'], ['sendToBack', new Set(['card'])],
    ['prevent'], ['bringForward', 'card'], ['prevent'], ['sendBackward', 'card']]);
  h.calls.length = 0; h.state.interactionRef.current = { kind: 'pan' }; h.key('1', { code: 'Digit1', shiftKey: true });
  h.key('+', { code: 'Equal', ctrlKey: true }); assert.deepEqual(h.calls, [['prevent']]);
});

test('dynamic tool dispatch keeps the tool map receiver and disposal removes the binding', () => {
  const h = harness(); const tools = h.state.shortcutToolHandlersRef.current;
  tools.stickyTool = function () { assert.equal(this, tools); h.calls.push(['nativeLikeTool']); };
  h.key('s'); assert.deepEqual(h.calls, [['prevent'], ['nativeLikeTool']]);
  h.controller.dispose(); h.key('s'); assert.equal(h.calls.length, 2);
});
