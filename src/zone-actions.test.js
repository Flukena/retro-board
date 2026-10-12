import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveRevealed, zoneEffectiveRevealed, zoneGroupIds } from './zone-actions.js';
const root = { id: 'root', type: 'zone', x: 0, y: 0, w: 1000, h: 1000, revealed: true };
const child = { id: 'child', type: 'zone', x: 50, y: 50, w: 400, h: 400, parentZoneId: 'root' };
const note = { id: 'note', type: 'sticky', x: 80, y: 80, parentZoneId: 'child' };

test('reveal follows ancestors, explicit zone overrides and legacy default', () => {
  assert.equal(zoneEffectiveRevealed(child, [root, child], false), true);
  assert.equal(zoneEffectiveRevealed({ ...child, revealed: false }, [root, child], true), false);
  assert.equal(effectiveRevealed(note, [root, child, note], false), true);
  assert.equal(zoneEffectiveRevealed({ ...root, revealed: undefined }, [root], false), false);
  assert.equal(zoneEffectiveRevealed({ ...root, revealed: undefined }, [root], true), true);
});

test('zone groups retain nested owned cards and exclude explicitly unzoned items', () => {
  const outside = { ...note, id: 'outside', parentZoneId: null };
  assert.deepEqual([...zoneGroupIds(root, [root, child, note, outside])], ['root', 'child', 'note']);
  assert.deepEqual([...zoneGroupIds(child, [root, child, note])], ['child', 'note']);
});
