import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_ITEM_TYPES, PUBLIC_TEXT_MAX_CHARACTERS } from './public-wall-contract.js';
import { BOARD_TEXT_MAX_LENGTH } from './security-boundaries.js';

test('public contract admits shared board images and bounds preview text below board text', () => {
  assert.deepEqual(PUBLIC_ITEM_TYPES, ['sticky', 'text', 'zone', 'image']);
  assert.equal(Object.isFrozen(PUBLIC_ITEM_TYPES), true);
  assert.ok(PUBLIC_TEXT_MAX_CHARACTERS <= BOARD_TEXT_MAX_LENGTH);
});
