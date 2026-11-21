import test from 'node:test';
import assert from 'node:assert/strict';
import { routeBoardKey } from './board-key-router.js';

const cases = [
  ['focused text precedes comments escape', { key: 'Escape' }, { focusedText: true, commentsOpen: true }, null, false],
  ['name modal precedes comments escape', { key: 'Escape' }, { nameModal: true, commentsOpen: true }, null, false],
  ['comments escape precedes blocked target and following', { key: 'Escape' }, { commentsOpen: true, targetBlocked: true, following: true }, 'closeComments', true],
  ['comments suppress other shortcuts', { code: 'KeyZ', ctrlKey: true }, { commentsOpen: true }, null, false],
  ['blocked target precedes following', { key: 'Escape' }, { targetBlocked: true, following: true }, null, false],
  ['following escape precedes open dialog', { key: 'Escape' }, { following: true, dialogOpen: true }, 'stopFollowing', true],
  ['dialog suppresses shortcuts', { code: 'KeyZ', ctrlKey: true }, { dialogOpen: true }, null, false],
  ['tool handler precedes fit guards', { code: 'Digit1', shiftKey: true }, { tools: ['fitContent'], interacting: true }, 'fitContent', true],
  ['repeated tool is swallowed', { code: 'KeyS', repeat: true }, { tools: ['stickyTool'] }, null, false],
  ['fit during interaction is swallowed', { code: 'Digit1', shiftKey: true }, { interacting: true }, null, false],
  ['zoom during interaction prevents browser zoom', { code: 'Equal', ctrlKey: true }, { interacting: true }, null, true],
  ['creation escape leaves selection alone', { key: 'Escape' }, { creating: true, selected: true }, 'cancelCreation', false],
  ['plain escape clears selection', { key: 'Escape' }, {}, 'clearSelection', false],
  ['empty delete does nothing', { key: 'Delete' }, {}, null, false],
  ['delete selection', { key: 'Delete' }, { selected: true }, 'delete', false],
  ['empty copy does nothing', { code: 'KeyC', ctrlKey: true }, {}, null, false],
  ['empty paste does nothing', { code: 'KeyV', ctrlKey: true }, {}, null, false],
  ['pan has no board-key action', { code: 'Space' }, {}, null, false],
  ['unknown key', { code: 'F12' }, {}, null, false],
];
for (const [code, action, extra] of [
  ['KeyZ', 'undo', {}], ['KeyZ', 'redo', { shiftKey: true }],
  ['KeyC', 'copy', {}], ['KeyX', 'cut', {}], ['KeyV', 'paste', {}],
  ['KeyD', 'duplicate', {}], ['KeyA', 'selectAll', {}],
  ['Equal', 'zoomIn', {}], ['Minus', 'zoomOut', {}], ['Digit0', 'zoomReset', {}],
  ['BracketRight', 'forward', {}], ['BracketLeft', 'backward', {}],
]) cases.push([action, { code, ctrlKey: true, ...extra }, { selected: true, clipboard: true }, action, true]);
for (const [code, action, extra] of [
  ['BracketRight', 'front', {}], ['BracketLeft', 'back', {}],
  ['Digit1', 'fitContent', { shiftKey: true }], ['Digit2', 'fitSelection', { shiftKey: true }],
  ['KeyS', 'stickyTool', {}],
]) cases.push([action, { code, ...extra }, { tools: ['stickyTool'] }, action, true]);
for (const [label, event, state, action, preventDefault] of cases) {
  test(label, () => {
    assert.deepEqual(routeBoardKey(event, state), { action, preventDefault });
  });
}
