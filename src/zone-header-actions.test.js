import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoneHeaderActions } from './zone-header-actions.js';

test('stable actions read latest context, start explicitly, stop own timer and gate admins', () => {
  const calls = [];
  let context = { isAdmin: true, board: { items: [{ id: 'zone', type: 'zone', revealed: true }], allRevealed: false },
    selectZone: (id) => calls.push(['select', id]), clearEditing: (value) => calls.push(['edit', value]),
    openTimerSetup: (value) => calls.push(['open', value]), stopTimer: (id) => calls.push(['stop', id]),
    updateZone: (...args) => calls.push(['update', ...args]) };
  const actions = createZoneHeaderActions(() => context);
  actions.vote('zone');
  assert.deepEqual(calls.splice(0), [['select', 'zone'], ['edit', null], ['open', true]]);
  actions.toggleReveal('zone');
  assert.deepEqual(calls.splice(0), [['update', 'zone', { revealed: false }]]);
  context.board.items[0].voteTimer = { endsAt: 1 };
  actions.vote('zone');
  assert.deepEqual(calls.splice(0), [['stop', 'zone']]);
  context = { ...context, isAdmin: false };
  actions.vote('zone'); actions.toggleReveal('zone');
  assert.deepEqual(calls, []);
  actions.options('zone');
  assert.deepEqual(calls, [['select', 'zone']]);
});
