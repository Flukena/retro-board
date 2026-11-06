import test from 'node:test';
import assert from 'node:assert/strict';
import { isAccountId, isSessionGeneration, isSessionGenerationText } from './account-identity.js';

test('account ids are 16 to 64 base64url characters', () => {
  assert.equal(isAccountId('A'.repeat(16)), true);
  assert.equal(isAccountId('a_-9'.repeat(16)), true);
  for (const id of ['x', 'A'.repeat(15), 'A'.repeat(65), 'bad.id.with.dots', `${'A'.repeat(16)}=`, 16, null]) {
    assert.equal(isAccountId(id), false, String(id));
  }
});

test('session generations are non-negative integers of at most 15 digits', () => {
  for (const generation of [0, 1, 999_999_999_999_999]) assert.equal(isSessionGeneration(generation), true, String(generation));
  for (const generation of [-1, 1.5, 1e15, Number.NaN, '1', null]) assert.equal(isSessionGeneration(generation), false, String(generation));
});

test('generation text in a cookie uses the same 15-digit bound', () => {
  assert.equal(isSessionGenerationText('0'), true);
  assert.equal(isSessionGenerationText('9'.repeat(15)), true);
  for (const text of ['', '-1', '1e3', '1'.repeat(16), ' 1']) assert.equal(isSessionGenerationText(text), false, text);
});
