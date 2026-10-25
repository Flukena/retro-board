import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoneHeaderActions } from './zone-header-actions.js';

function fixture() {
  const calls = [];
  const zone = { id: 'target', type: 'zone', locked: false, revealed: true };
  const context = { isAdmin: true, board: { items: [zone, { id: 'other', type: 'zone' }], allRevealed: false },
    canModify: () => true, canDelete: () => true };
  for (const name of ['selectZone', 'clearEditing', 'openTimerSetup', 'stopTimer', 'startTimer',
    'updateZone', 'exportCsv', 'openSaveTemplate', 'bringToFront', 'sendToBack', 'deleteItemsIfAllowed']) {
    context[name] = (...args) => calls.push([name, ...args]);
  }
  return { context, calls, zone, actions: createZoneHeaderActions(() => context) };
}

test('vote opens setup for its id without selecting, stops its own timer and gates admins', () => {
  const { context, calls, zone, actions } = fixture();
  actions.vote(zone.id);
  assert.deepEqual(calls.splice(0), [['clearEditing', null], ['openTimerSetup', zone.id]]);
  actions.toggleReveal(zone.id);
  assert.deepEqual(calls.splice(0), [['updateZone', zone.id, { revealed: false }]]);
  actions.startTimer(zone.id, 5, 3, true, false);
  assert.deepEqual(calls.splice(0), [['startTimer', zone.id, 5, 3, true, false]]);
  zone.voteTimer = { endsAt: 1 };
  actions.vote(zone.id);
  assert.deepEqual(calls.splice(0), [['stopTimer', zone.id]]);
  context.isAdmin = false;
  actions.vote(zone.id); actions.toggleReveal(zone.id); actions.startTimer(zone.id, 5);
  assert.deepEqual(calls, []);
  actions.closeTimerSetup();
  assert.deepEqual(calls, [['openTimerSetup', null]]);
  assert.equal(actions.options, undefined);
});

test('zone tools operate on the supplied id and recheck the latest edit/delete guards', () => {
  const { context, calls, zone, actions } = fixture();
  actions.color(zone.id, 2); actions.fontSize(zone.id, 24); actions.toggleLock(zone.id);
  actions.exportCsv(zone.id); actions.saveTemplate(zone.id);
  actions.bringToFront(zone.id); actions.sendToBack(zone.id); actions.remove(zone.id);
  assert.deepEqual(calls.splice(0), [
    ['updateZone', zone.id, { color: 2 }], ['updateZone', zone.id, { fontSize: 24 }],
    ['updateZone', zone.id, { locked: true }], ['exportCsv', zone],
    ['openSaveTemplate', context.board.items, new Set([zone.id])],
    ['bringToFront', new Set([zone.id])], ['sendToBack', new Set([zone.id])],
    ['deleteItemsIfAllowed', [zone.id]],
  ]);
  context.canModify = (candidate) => candidate.id !== zone.id;
  context.canDelete = (candidate) => candidate.id !== zone.id;
  actions.color(zone.id, 1); actions.fontSize(zone.id, 10); actions.toggleLock(zone.id);
  actions.bringToFront(zone.id); actions.sendToBack(zone.id); actions.remove(zone.id);
  assert.deepEqual(calls, []);
  // Read-only export and template snapshots remain available without edit rights.
  actions.exportCsv(zone.id); actions.saveTemplate(zone.id);
  assert.equal(calls.length, 2);
  calls.length = 0;
  for (const id of ['missing', 'sticky']) {
    context.board.items.push({ id: 'sticky', type: 'sticky' });
    actions.color(id, 1); actions.fontSize(id, 12); actions.toggleLock(id);
    actions.exportCsv(id); actions.saveTemplate(id); actions.bringToFront(id);
    actions.sendToBack(id); actions.remove(id); actions.vote(id); actions.startTimer(id, 5); actions.toggleReveal(id);
  }
  assert.deepEqual(calls, []);
});
