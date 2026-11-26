import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_REACTIONS, BOARD_REACTION_FIELD, FIREWORKS_REACTION, REACTION_SEND_INTERVAL_MS, boardReaction, decodeBoardReaction,
} from './board-reactions.js';

const VALID = Object.freeze({ emoji: '👏', seq: 3 });

test('the picker offers the approved reactions, with fireworks first and axe last', () => {
  assert.deepEqual([...BOARD_REACTIONS], ['🎆', '👏', '❤️', '😂', '🔥', '👍', '🪓']);
  assert.equal(FIREWORKS_REACTION, '🎆');
  assert.ok(Object.isFrozen(BOARD_REACTIONS));
  assert.notEqual(BOARD_REACTION_FIELD, 'reaction', 'Planning Poker already owns the `reaction` presence field');
});

test('about one reaction per second per person: the owner asked for ~1/s', () => {
  assert.equal(REACTION_SEND_INTERVAL_MS, 1000);
});

test('a whitelisted reaction round-trips through presence JSON as emoji and seq only', () => {
  for (const emoji of BOARD_REACTIONS) {
    const sent = boardReaction(emoji, VALID.seq);
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), { emoji, seq: VALID.seq }, 'no sender clock is published');
    assert.deepEqual(decodeBoardReaction(JSON.parse(JSON.stringify(sent))), { emoji, seq: VALID.seq });
  }
});

test('a sender timestamp from a peer is ignored, never trusted', () => {
  assert.deepEqual(decodeBoardReaction({ ...VALID, at: -1 }), { ...VALID });
});

test('emoji outside the whitelist are rejected, including the picker button itself', () => {
  for (const emoji of ['🎉', '💩', '', ' 👏', '👏👏', '❤', 'clap', null, 7]) {
    assert.equal(boardReaction(emoji, VALID.seq), null, String(emoji));
    assert.equal(decodeBoardReaction({ ...VALID, emoji }), null, String(emoji));
  }
});

test('anything but a plain object is not a reaction', () => {
  for (const raw of [null, undefined, 'clap', 3, true, [VALID.emoji, VALID.seq], Object.create(VALID)]) {
    assert.equal(decodeBoardReaction(raw), null, String(raw));
  }
  assert.equal(decodeBoardReaction({ emoji: VALID.emoji }), null, 'missing seq');
});

test('seq must be a positive safe integer', () => {
  const badSeqs = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '3', null];
  for (const seq of badSeqs) assert.equal(decodeBoardReaction({ ...VALID, seq }), null, `seq ${String(seq)}`);
});

test('a decoded reaction is frozen so a renderer cannot mutate shared presence', () => {
  assert.ok(Object.isFrozen(decodeBoardReaction({ ...VALID })));
});
