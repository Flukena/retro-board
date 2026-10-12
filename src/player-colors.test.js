import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarInitial, hueFromId } from './player-colors.js';

test('avatar initial handles whitespace and missing names', () => {
  assert.equal(avatarInitial('  alice'), 'A');
  assert.equal(avatarInitial('  '), '?');
  assert.equal(avatarInitial(null), '?');
});
test('player hue preserves the stable character hash and wraps into hue range', () => {
  assert.equal(hueFromId(''), 0);
  assert.equal(hueFromId('A'), 65);
  assert.equal(hueFromId('AA'), (65 * 31 + 65) % 360);
  assert.ok(hueFromId('long-player-id') >= 0 && hueFromId('long-player-id') < 360);
});
