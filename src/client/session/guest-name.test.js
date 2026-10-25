import test from 'node:test';
import assert from 'node:assert/strict';
import { randomGuestName } from './guest-name.js';

test('guest name uses one supplied random draw and keeps the four digit range', () => {
  let draws = 0;
  assert.equal(randomGuestName(() => { draws += 1; return 0; }), 'Guest-1000');
  assert.equal(draws, 1);
  assert.equal(randomGuestName(() => 0.5), 'Guest-5500');
  assert.equal(randomGuestName(() => 1 - Number.EPSILON), 'Guest-9999');
});
