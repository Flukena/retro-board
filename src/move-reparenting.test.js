import test from 'node:test';
import assert from 'node:assert/strict';
import { reparentMoveEntries } from './move-reparenting.js';

// Board-pixel fixture dimensions and wire identities.
const ZONE = { id: 'zone', type: 'zone', x: 0, y: 0, w: 400, h: 400 };
const CARD = { id: 'card', type: 'sticky', x: 600, y: 0, w: 100, h: 100, parentZoneId: null };
const MOVE = { id: CARD.id, patch: { x: 20, y: 20 } };

test('final reparent keeps geometry and adds the resolved owner without mutating inputs', () => {
  assert.deepEqual(reparentMoveEntries([ZONE, CARD], [MOVE], [CARD.id]),
    [{ id: CARD.id, patch: { ...MOVE.patch, parentZoneId: ZONE.id } }]);
  assert.equal(Object.hasOwn(MOVE.patch, 'parentZoneId'), false);
  assert.equal(CARD.parentZoneId, null);
});

test('dragged zone releases uncovered children; locked and missing primaries are ignored', () => {
  const child = { ...CARD, x: 20, y: 20, parentZoneId: ZONE.id };
  const ZONE_MOVE_X_PX = 600;
  const entries = [{ id: ZONE.id, patch: { x: ZONE_MOVE_X_PX } }];
  assert.deepEqual(reparentMoveEntries([ZONE, child], entries, [ZONE.id]), [
    { id: ZONE.id, patch: { x: ZONE_MOVE_X_PX, parentZoneId: null } },
    { id: CARD.id, patch: { parentZoneId: null } },
  ]);
  assert.deepEqual(reparentMoveEntries([{ ...ZONE, locked: true }, child], entries, [ZONE.id, 'missing']), entries);
});
