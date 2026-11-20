import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionController } from './use-selection.js';

function harness() {
  const selectedIdsRef = { current: new Set(['old']) };
  const focusedTextIdRef = { current: null };
  const events = [];
  const storage = { setLocalBusyItems(kind, ids) { assert.equal(this, storage); events.push(['busy', kind, ids]); } };
  const controller = createSelectionController({ selectedIdsRef, focusedTextIdRef, storage,
    setSelectedIds: ids => events.push(['selected', ids]),
    setFocusedTextId: value => { assert.equal(focusedTextIdRef.current, value, 'focus ref must precede state'); events.push(['focus', value]); },
  });
  return { selectedIdsRef, focusedTextIdRef, events, controller };
}

test('selection mirrors the committed set by identity; single selection handles clear and one item', () => {
  const h = harness();
  const next = new Set(['a', 'b']);
  h.controller.mirror(next);
  assert.equal(h.selectedIdsRef.current, next);
  h.controller.selectOne('a');
  h.controller.selectOne(null);
  assert.deepEqual(h.events, [['selected', new Set(['a'])], ['selected', new Set()]]);
  assert.equal(h.selectedIdsRef.current, next, 'selection mirroring remains in its original effect');

});

test('focus updates its ref before React state, then publishes item busy state and clears it', () => {
  const h = harness();
  h.controller.focus('card:body');
  h.controller.focus(null);
  assert.deepEqual(h.events, [['focus', 'card:body'], ['busy', 'text', ['card']], ['focus', null], ['busy', 'text', []]]);
  assert.equal(h.focusedTextIdRef.current, null);
});
