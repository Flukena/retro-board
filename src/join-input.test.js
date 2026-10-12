import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJoinInput } from './join-input.js';

test('join accepts trimmed codes and share URLs with optional trailing slash', () => {
  for (const raw of ['abc', '  abc  ', 'https://retro.example/b/abc', '/b/abc/', 'abc/']) {
    assert.deepEqual(parseJoinInput(raw), { code: 'abc', token: null });
  }
  for (const raw of ['https://retro.example/b/abc#secret_1', 'http://retro.example/b/abc/#secret_1']) {
    assert.deepEqual(parseJoinInput(raw), { code: 'abc', token: 'secret_1' });
  }
});

test('join rejects invalid codes and accepts bounded ASCII letters, digits, underscore and hyphen', () => {
  for (const raw of ['', '  ', 'ab', 'a'.repeat(33), 'abc!', 'กขค', 'a b', 'abc?query=1']) {
    assert.equal(parseJoinInput(raw), null);
  }
  for (const code of ['A_0-', 'a'.repeat(32)]) {
    assert.deepEqual(parseJoinInput(code), { code, token: null });
  }
});

test('join retains valid tokens at both bounds and drops invalid or empty hashes', () => {
  for (const token of ['Ab_0-xyz', 'a'.repeat(64)]) {
    assert.deepEqual(parseJoinInput(`abc#${token}`), { code: 'abc', token });
  }
  for (const token of ['', 'short', 'a'.repeat(65), 'invalid!', 'abcdefgh#extra']) {
    assert.deepEqual(parseJoinInput(`abc#${token}`), { code: 'abc', token: null });
  }
  assert.deepEqual(parseJoinInput('  /b/abc/#secret_1  '), { code: 'abc', token: 'secret_1' });
});
