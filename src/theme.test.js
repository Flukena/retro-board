import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTokens, TOKENS } from './theme.js';

test('theme modes have matching CSS variable keys and are frozen', () => {
  assert.deepEqual(Object.keys(TOKENS.light).sort(), Object.keys(TOKENS.dark).sort());
  assert.ok(Object.keys(TOKENS.light).every((key) => key.startsWith('--')));
  for (const value of [TOKENS, TOKENS.light, TOKENS.dark]) assert.ok(Object.isFrozen(value));
  const a = { '--bg': 'white' };
  const b = { '--bg': 'black' };
  const tokens = defineTokens(a, b);
  assert.equal(Object.isFrozen(a), false);
  for (const value of [tokens, tokens.light, tokens.dark]) assert.ok(Object.isFrozen(value));
});

test('token definitions reject missing, extra, invalid keys and non-plain objects', () => {
  assert.throws(() => defineTokens({ '--bg': 'white' }, {}), /missing.*--bg/i);
  assert.throws(() => defineTokens({}, { '--extra': 'black' }), /extra.*--extra/i);
  assert.throws(() => defineTokens({ bg: 'white' }, { bg: 'black' }), /--/);
  for (const invalid of [null, [], 'white', 1, new Date()]) {
    assert.throws(() => defineTokens(invalid, {}), Error);
    assert.throws(() => defineTokens({}, invalid), Error);
  }
});
