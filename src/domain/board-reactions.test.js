import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_REACTIONS, BOARD_REACTION_FIELD, FIREWORKS_REACTION, boardReaction, decodeBoardReaction,
} from './board-reactions.js';

const VALID = Object.freeze({ emoji: '👏', seq: 3, at: 1_700_000_000_000 });

test('the picker offers exactly the six approved reactions, fireworks first', () => {
  assert.deepEqual([...BOARD_REACTIONS], ['🎆', '👏', '❤️', '😂', '🔥', '👍']);
  assert.equal(FIREWORKS_REACTION, '🎆');
  assert.ok(Object.isFrozen(BOARD_REACTIONS));
  assert.notEqual(BOARD_REACTION_FIELD, 'reaction', 'Planning Poker already owns the `reaction` presence field');
});

test('a whitelisted reaction round-trips through presence JSON', () => {
  for (const emoji of BOARD_REACTIONS) {
    const sent = boardReaction(emoji, VALID.seq, VALID.at);
    assert.deepEqual(decodeBoardReaction(JSON.parse(JSON.stringify(sent))), { emoji, seq: VALID.seq, at: VALID.at });
  }
});

test('emoji outside the whitelist are rejected, including the picker button itself', () => {
  for (const emoji of ['🎉', '💩', '', ' 👏', '👏👏', '❤', 'clap', null, 7]) {
    assert.equal(boardReaction(emoji, VALID.seq, VALID.at), null, String(emoji));
    assert.equal(decodeBoardReaction({ ...VALID, emoji }), null, String(emoji));
  }
});

test('anything but a plain object is not a reaction', () => {
  for (const raw of [null, undefined, 'clap', 3, true, [VALID.emoji, VALID.seq, VALID.at], Object.create(VALID)]) {
    assert.equal(decodeBoardReaction(raw), null, String(raw));
  }
  assert.equal(decodeBoardReaction({ emoji: VALID.emoji, seq: VALID.seq }), null, 'missing at');
  assert.equal(decodeBoardReaction({ emoji: VALID.emoji, at: VALID.at }), null, 'missing seq');
});

test('seq must be a positive safe integer and at a positive finite time', () => {
  const badSeqs = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '3', null];
  for (const seq of badSeqs) assert.equal(decodeBoardReaction({ ...VALID, seq }), null, `seq ${String(seq)}`);
  const badTimes = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1700000000000', null];
  for (const at of badTimes) assert.equal(decodeBoardReaction({ ...VALID, at }), null, `at ${String(at)}`);
});

test('a decoded reaction is frozen so a renderer cannot mutate shared presence', () => {
  assert.ok(Object.isFrozen(decodeBoardReaction({ ...VALID })));
});
