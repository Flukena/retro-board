import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VIEWPORT,
  readLocalPreference,
  writeLocalPreference,
  normalizeDisplayName,
  normalizeStoredUserId,
  normalizeViewport,
} from './local-preferences.js';

test('normalizes stored identity values before they reach awareness', () => {
  assert.equal(normalizeStoredUserId('safe-user_123'), 'safe-user_123');
  assert.equal(normalizeStoredUserId({}), null);
  assert.equal(normalizeStoredUserId('__proto__'), null);
  assert.equal(normalizeDisplayName(`  ${'A'.repeat(200)}  `).length, 120);
  assert.equal(normalizeDisplayName(42), '');
});

test('repairs malformed viewport records and clamps valid extremes', () => {
  assert.deepEqual(normalizeViewport('bad'), DEFAULT_VIEWPORT);
  assert.deepEqual(normalizeViewport({ x: 1, y: 2, zoom: 0 }), { x: 1, y: 2, zoom: 0.05 });
  assert.deepEqual(normalizeViewport({ x: 99_000_000, y: -99_000_000, zoom: 9 }), {
    x: 10_000_000,
    y: -10_000_000,
    zoom: 3,
  });
});

test('corrupt or inaccessible device storage falls back without throwing', () => {
  assert.equal(readLocalPreference('viewport', { getItem: () => '{' }), null);
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readLocalPreference('viewport', unavailable), null);
  assert.equal(writeLocalPreference('viewport', {}, unavailable), false);
});
