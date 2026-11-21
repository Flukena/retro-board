import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditingPresenceChannel, createLocalEditingPresence } from './use-editing-presence.js';
import { createFakeClock } from '../../test-support/fake-clock.js';

for (const kind of ['editing', 'selection']) {
  test(`${kind} presence clones snapshots, prefers event maps, and unsubscribes on disposal`, () => {
    const clock = createFakeClock();
    const listeners = new Set();
    const snapshot = new Map([['note', new Map([['peer', { name: 'Peer' }]])]]);
    const storage = {};
    for (const name of ['getRemoteEditingItems', 'getRemoteSelectedItems']) storage[name] = function () { assert.equal(this, storage); return snapshot; };
    for (const name of ['onEditingChange', 'onSelectionChange']) storage[name] = function (callback) {
      assert.equal(this, storage); listeners.add(callback); return () => listeners.delete(callback);
    };
    const values = [];
    const channel = createEditingPresenceChannel(storage, kind, value => values.push(value));
    assert.deepEqual(values, [snapshot]);
    assert.notEqual(values[0], snapshot);
    const eventMap = new Map([['other', new Map()]]);
    listeners.forEach(run => run({ detail: eventMap }));
    assert.deepEqual(values[1], eventMap);
    assert.notEqual(values[1], eventMap);
    listeners.forEach(run => run({ detail: null }));
    assert.deepEqual(values[2], snapshot);
    clock.setTimeout(() => listeners.forEach(run => run()), 1);
    channel.dispose();
    clock.advance(1);
    assert.equal(listeners.size, 0);
    assert.equal(values.length, 3);
    assert.equal(clock.pendingCount(), 0);
  });
}

test('local editing presence publishes selection and clears text busy claim and selection on disposal', () => {
  const clock = createFakeClock();
  const events = [];
  const storage = {
    setLocalBusyItems(kind, ids) { assert.equal(this, storage); events.push([kind, ids]); },
    setLocalSelectedItems(ids) { assert.equal(this, storage); events.push(['selection', ids]); },
  };
  const controller = createLocalEditingPresence(storage);
  const selected = new Set(['note']);
  controller.publishSelected(selected);
  controller.dispose();
  clock.advance(100);
  assert.deepEqual(events, [['selection', selected], ['text', []], ['selection', []]]);
  assert.equal(clock.pendingCount(), 0);
});
