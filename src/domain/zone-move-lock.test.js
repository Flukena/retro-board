import test from 'node:test';
import assert from 'node:assert/strict';
import { filterLockedZoneMoves } from './zone-move-lock.js';

const zone = (id, parentZoneId = null, locked = false) => ({ id, type: 'zone', x: 0, y: 0, w: 1000, h: 1000, parentZoneId, locked });
const move = (id, patch = { x: 10, y: 20 }) => ({ id, patch });
const outer = zone('outer');
const inner = zone('inner', 'outer', true);
const leaf = zone('leaf', 'inner', true);
const cases = [
  { name: 'unlocked zones move directly', items: [outer], entries: [move('outer')], allowed: ['outer'] },
  { name: 'a locked zone cannot move directly', items: [inner, outer], entries: [move('inner')], allowed: [] },
  { name: 'an unlocked owner carries a locked child', items: [inner, outer], entries: [move('inner'), move('outer')], allowed: ['inner', 'outer'] },
  { name: 'a carried child cannot resize', items: [inner, outer], entries: [move('outer'), move('inner', { x: 10, w: 200 })], allowed: ['outer'] },
  { name: 'height-only resize is also forbidden', items: [inner, outer], entries: [move('outer'), move('inner', { h: 200 })], allowed: ['outer'] },
  { name: 'nested locked zones follow a moving unlocked ancestor', items: [outer, inner, leaf], entries: [move('leaf'), move('inner'), move('outer')], allowed: ['leaf', 'inner', 'outer'] },
  { name: 'presence of a nonmoving locked owner is insufficient', items: [outer, inner, leaf], entries: [move('leaf'), move('inner')], allowed: [] },
  { name: 'a resized locked owner cannot carry its child', items: [outer, inner, leaf], entries: [move('outer'), move('inner', { w: 300 }), move('leaf')], allowed: ['outer'] },
  { name: 'explicitly unowned locked zones do not inherit by geometry', items: [outer, zone('inner', null, true)], entries: [move('outer'), move('inner')], allowed: ['outer'] },
  { name: 'non-zone locks do not block geometry', items: [{ id: 'sticky', type: 'sticky', locked: true }], entries: [move('sticky')], allowed: ['sticky'] },
  { name: 'unknown ids retain legacy filtering behavior', items: [], entries: [move('unknown')], allowed: ['unknown'] },
  { name: 'cyclic persisted ownership fails closed', items: [zone('a', 'b', true), zone('b', 'a', true)], entries: [move('a'), move('b')], allowed: [] },
];
for (const { name, items, entries, allowed } of cases) {
  test(name, () => {
    const before = structuredClone({ items, entries });
    const result = filterLockedZoneMoves(items, entries);
    assert.deepEqual(result.map(({ id }) => id), allowed);
    assert.ok(result.every(entry => entries.includes(entry)));
    assert.deepEqual({ items, entries }, before);
  });
}

test('legacy geometric ownership carries a nested zone without a persisted parent', () => {
  const legacy = { id: 'legacy', type: 'zone', x: 10, y: 10, w: 200, h: 200, locked: true };
  const entries = [move('outer'), move('legacy')];
  assert.deepEqual(filterLockedZoneMoves([outer, legacy], entries), entries);
});
