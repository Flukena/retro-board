import test from 'node:test';
import assert from 'node:assert/strict';

import { isSafeId, normalizeComment } from './comment-schema.js';

test('IDs reject object meta-properties used in untrusted map-to-object paths', () => {
  ['__proto__', 'constructor', 'prototype'].forEach((value) => {
    assert.equal(isSafeId(value), false, value);
    assert.equal(normalizeComment({ text: 'unsafe' }, value), null, value);
  });
  assert.equal(isSafeId('sticky_123-safe'), true);
});
