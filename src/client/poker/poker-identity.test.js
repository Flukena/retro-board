import test from 'node:test';
import assert from 'node:assert/strict';

import { DISPLAY_NAME_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { loadPokerIdentity, savePokerName } from './poker-identity.js';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
}

test('a device keeps the same participant id across loads', () => {
  const storage = new MemoryStorage();
  let created = 0;
  const createId = () => { created += 1; return `user${created}`; };
  const first = loadPokerIdentity(createId, storage);
  const second = loadPokerIdentity(createId, storage);
  assert.equal(first.userId, 'user1');
  assert.equal(second.userId, 'user1');
  assert.equal(created, 1);
});

test('a corrupt stored id is replaced with a fresh one', () => {
  const storage = new MemoryStorage();
  storage.setItem('rb_poker_userId', JSON.stringify('bad id with spaces'));
  assert.equal(loadPokerIdentity(() => 'fresh', storage).userId, 'fresh');
});

test('the saved name is trimmed, length-limited and returned on the next load', () => {
  const storage = new MemoryStorage();
  assert.equal(loadPokerIdentity(() => 'u', storage).userName, '');
  const saved = savePokerName(`  ${'n'.repeat(DISPLAY_NAME_MAX_LENGTH + 10)}  `, storage);
  assert.equal(saved.length, DISPLAY_NAME_MAX_LENGTH);
  assert.equal(loadPokerIdentity(() => 'u', storage).userName, saved);
});
