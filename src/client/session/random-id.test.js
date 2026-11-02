import test from 'node:test';
import assert from 'node:assert/strict';

import { isSafeId } from '../../domain/comment-schema.js';
import { createRandomId } from './random-id.js';

test('random ids are safe document ids and do not repeat', () => {
  const ids = new Set(Array.from({ length: 500 }, () => createRandomId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.equal(isSafeId(id), true, id);
});

test('ids are derived from the crypto source bytes', () => {
  const zeros = { getRandomValues: (bytes) => bytes.fill(0) };
  const highs = { getRandomValues: (bytes) => bytes.fill(255) };
  assert.equal(createRandomId(zeros), 'AAAAAAAAAAAA');
  assert.equal(createRandomId(highs), '------------');
});
