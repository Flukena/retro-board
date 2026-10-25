import test from 'node:test';
import assert from 'node:assert/strict';
import { boardEditingAllowed, boardManagementPermissions, runSharedBoardAction } from './public-board-permissions.js';

test('public editing ignores legacy board locks while private editing retains its owner gate', () => {
  for (const privateAdmin of [false, true]) {
    for (const editingLocked of [false, true]) {
      assert.equal(boardEditingAllowed('public', privateAdmin, editingLocked), true);
    }
  }
  assert.equal(boardEditingAllowed('private', false, true), false);
  assert.equal(boardEditingAllowed('private', true, true), true);
  assert.equal(boardEditingAllowed('private', false, false), true);
});

test('all public writers can manage shared tools without becoming private owners', () => {
  assert.deepEqual(boardManagementPermissions('public', false), { canManage: true, isPrivateAdmin: false });
  assert.deepEqual(boardManagementPermissions('private', false), { canManage: false, isPrivateAdmin: false });
  assert.deepEqual(boardManagementPermissions('private', true), { canManage: true, isPrivateAdmin: true });
});

test('public shared actions bypass only the PIN gate while private management still uses its existing gate', () => {
  const calls = [];
  const action = () => { calls.push('action'); };
  const pin = (run) => { calls.push('pin'); run(); };
  runSharedBoardAction('public', pin, action);
  assert.deepEqual(calls, ['action']);
  runSharedBoardAction('private', pin, action);
  assert.deepEqual(calls, ['action', 'pin', 'action']);
});
