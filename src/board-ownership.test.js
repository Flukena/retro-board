import test from 'node:test';
import assert from 'node:assert/strict';
import { centerOf, effectiveOwnerZone, resolveOwnerZone } from './board-ownership.js';

const outer = { id: 'outer', type: 'zone', x: 0, y: 0, w: 1000, h: 1000 };
const left = { id: 'left', type: 'zone', x: 10, y: 10, w: 400, h: 400, parentZoneId: 'outer' };
const right = { ...left, id: 'right' };
const sticky = { id: 'note', type: 'sticky', x: 100, y: 100, w: 100, h: 100 };

test('zone ownership keeps explicit null, legacy geometry, incumbent ties and containment rules', () => {
  const items = [outer, left, right, sticky];
  assert.equal(effectiveOwnerZone(sticky, items), left);
  assert.equal(effectiveOwnerZone({ ...sticky, parentZoneId: null }, items), null);
  assert.equal(effectiveOwnerZone({ ...sticky, parentZoneId: 'right' }, items), right);
  assert.equal(resolveOwnerZone({ ...sticky, parentZoneId: 'right' }, items), right);
  assert.equal(effectiveOwnerZone({ ...sticky, parentZoneId: 'left', x: 900 }, items), null);
  assert.equal(effectiveOwnerZone({ ...sticky, parentZoneId: 'missing' }, items), null);
  assert.equal(effectiveOwnerZone({ ...left, parentZoneId: 'left' }, items), null);
  assert.equal(effectiveOwnerZone(left, items), outer);
});

test('an updated snapshot replaces cached zones so nested privacy and geometry use the latest parent', () => {
  const note = { ...sticky, parentZoneId: 'left' };
  const before = [left, note];
  assert.equal(effectiveOwnerZone(note, before), left);
  const moved = { ...left, x: 800, revealed: false, locked: true };
  assert.equal(effectiveOwnerZone(note, [moved, note]), null);
  const resized = { ...left, revealed: false, locked: true };
  assert.equal(effectiveOwnerZone(note, [resized, note]), resized);
});

test('repeated persistent ownership reads do not rescan unrelated cards', () => {
  let visits = 0;
  const cards = Array.from({ length: 4000 }, (_, index) => ({
    get id() { visits++; return `note-${index}`; }, x: 100, y: 100, w: 100, h: 100, parentZoneId: 'left',
    type: 'sticky',
  }));
  const items = [...cards, left];
  cards.forEach(card => assert.equal(effectiveOwnerZone(card, items), left));
  assert.ok(visits <= cards.length + 10, `unrelated cards were scanned ${visits} times`);
});

test('ownership lookup retains item-type default centers for legacy dimensions', () => {
  assert.deepEqual(centerOf({ type: 'sticky', x: 10, y: 20 }), { x: 110, y: 110 });
  assert.deepEqual(centerOf({ type: 'text', x: 10, y: 20 }), { x: 210, y: 60 });
  assert.deepEqual(centerOf({ type: 'image', x: 10, y: 20 }), { x: 110, y: 120 });
});
