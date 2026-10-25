import test from 'node:test';
import assert from 'node:assert/strict';
import {
  avatarInitial, hueFromId, playerAccentColor, PLAYER_ACCENT_SATURATION_PERCENT, PLAYER_ACCENT_LIGHTNESS_PERCENT,
} from './player-colors.js';

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

test('player accents use the shared saturation and lightness with optional alpha', () => {
  const hue = hueFromId('alice');
  const definition = `${hue} ${PLAYER_ACCENT_SATURATION_PERCENT}% ${PLAYER_ACCENT_LIGHTNESS_PERCENT}%`;
  assert.equal(playerAccentColor(hue), `hsl(${definition})`);
  assert.equal(playerAccentColor(hue, 0.18), `hsl(${definition} / 0.18)`);
  assert.equal(playerAccentColor(hue, 0), `hsl(${definition} / 0)`);
});
