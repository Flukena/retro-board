import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoneMenuActions } from './zone-menu-actions.js';

test('style and reveal stay open; handoffs close before dispatching the same zone arguments', () => {
  const calls = [];
  const keepOpen = ['color', 'fontSize', 'toggleLock', 'toggleReveal'];
  const handoff = ['vote', 'exportCsv', 'saveTemplate', 'remove', 'bringToFront', 'sendToBack'];
  const source = Object.fromEntries([...keepOpen, ...handoff].map((key) => [key, (...args) => calls.push([key, ...args])]));
  const actions = createZoneMenuActions(source, () => calls.push('close'));
  for (const key of keepOpen) {
    actions[key]('zone-a', 2);
    assert.deepEqual(calls.splice(0), [[key, 'zone-a', 2]]);
  }
  for (const key of handoff) {
    actions[key]('zone-b');
    assert.deepEqual(calls.splice(0), ['close', [key, 'zone-b']]);
  }
});
