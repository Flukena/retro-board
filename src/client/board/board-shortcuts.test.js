import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SHORTCUTS, resolveBoardShortcut } from './board-shortcuts.js';

const press = (code, options = {}) => resolveBoardShortcut({ code, key: options.key ?? '', ...options });

test('board shortcut map resolves tools across keyboard layouts and preserves modifiers', () => {
  for (const [code, action] of [['KeyV', 'selectTool'], ['KeyT', 'textTool'], ['KeyZ', 'zoneTool'], ['KeyP', 'drawTool'], ['KeyS', 'stickyTool'], ['KeyI', 'imageTool']]) {
    assert.equal(press(code, { key: 'ก' }), action);
    assert.notEqual(press(code, { key: 'ก', ctrlKey: true }), action);
  }
  assert.equal(press('KeyZ', { ctrlKey: true }), 'undo');
  assert.equal(press('KeyZ', { metaKey: true, shiftKey: true }), 'redo');
  assert.equal(press('KeyY', { ctrlKey: true }), 'redo');
  assert.equal(press('Digit1', { shiftKey: true }), 'fitContent');
  assert.equal(press('BracketRight', { metaKey: true }), 'forward');
  assert.equal(press('KeyV', { altKey: true }), null);
});

test('every shortcut has a unique documented action and bindings', () => {
  assert.equal(new Set(BOARD_SHORTCUTS.map(item => item.action)).size, BOARD_SHORTCUTS.length);
  for (const item of BOARD_SHORTCUTS) {
    assert.ok(item.labelKey && item.display && item.bindings.length);
    for (const binding of item.bindings) assert.equal(resolveBoardShortcut(binding), item.action);
  }
});
