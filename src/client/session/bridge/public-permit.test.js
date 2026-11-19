import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage, VALID_ITEM } from '../../../test-support/bridge-harness.js';

const OVERSIZED_COUNT = 100;
test('public rejection is consumable once and expires at the next microtask', async () => {
  await withStorage(async ({ storage }) => {
    const items = Array.from({ length: OVERSIZED_COUNT }, (_, index) => ({ ...VALID_ITEM, id: `item${index}` }));
    assert.equal(storage.canCreateItems(items), false);
    assert.equal(storage.consumePublicCreationFailure(), true);
    assert.equal(storage.consumePublicCreationFailure(), false);
    assert.equal(storage.canCreateItems(items), false);
    await Promise.resolve();
    assert.equal(storage.consumePublicCreationFailure(), false);
  }, { publicWall: true });
});
