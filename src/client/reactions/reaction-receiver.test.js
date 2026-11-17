import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_REACTION_FIELD, boardReaction } from '../../domain/board-reactions.js';
import { REACTION_STALE_MS, ReactionReceiver } from './reaction-receiver.js';

const NOW_MS = 1_700_000_000_000;
const A = 11;
const B = 22;
const SELF = 33;
const NO_CHANGE = Object.freeze({ added: [], updated: [], removed: [] });

const stateWith = (emoji, seq, at = NOW_MS) => ({ user: { name: 'Ada' }, [BOARD_REACTION_FIELD]: boardReaction(emoji, seq, at) });
const idle = () => ({ user: { name: 'Ada' } });
const change = (patch) => ({ ...NO_CHANGE, ...patch });
const emojis = (plays) => plays.map(({ clientId, reaction }) => `${clientId}:${reaction.emoji}:${reaction.seq}`);

/** A receiver that has already seen A without a reaction. */
function receiverWithA() {
  const receiver = new ReactionReceiver();
  const states = new Map([[A, idle()]]);
  receiver.receive(change({ added: [A] }), states, NOW_MS);
  return { receiver, states };
}

test('a new seq from a known sender plays once, even when other presence fields keep changing', () => {
  const { receiver, states } = receiverWithA();
  states.set(A, stateWith('🎆', 1));
  assert.deepEqual(emojis(receiver.receive(change({ updated: [A] }), states, NOW_MS)), [`${A}:🎆:1`]);
  states.set(A, { ...states.get(A), cursor: { x: 5, y: 5 } });
  assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS + 50), [], 'cursor churn');
  states.set(A, { ...states.get(A), selectedItems: ['card'] });
  assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS + 90), [], 'selection churn');
});

test('the next send plays again; an older seq never replays', () => {
  const { receiver, states } = receiverWithA();
  states.set(A, stateWith('👏', 4));
  receiver.receive(change({ updated: [A] }), states, NOW_MS);
  states.set(A, stateWith('🔥', 5));
  assert.deepEqual(emojis(receiver.receive(change({ updated: [A] }), states, NOW_MS)), [`${A}:🔥:5`]);
  states.set(A, stateWith('👏', 4));
  assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS), []);
});

test('a reaction whose sender time is older than the stale window is ignored and not replayed later', () => {
  const { receiver, states } = receiverWithA();
  states.set(A, stateWith('🎆', 1, NOW_MS - REACTION_STALE_MS - 1));
  assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS), []);
  assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS - REACTION_STALE_MS), [], 'seq already consumed');
  states.set(A, stateWith('👍', 2, NOW_MS - REACTION_STALE_MS));
  assert.equal(receiver.receive(change({ updated: [A] }), states, NOW_MS).length, 1, 'inside the window still plays');
});

test('a sender clock ahead of ours still plays: skew is tolerated, not rejected', () => {
  const { receiver, states } = receiverWithA();
  const CLOCK_AHEAD_MS = 60_000;
  states.set(A, stateWith('😂', 1, NOW_MS + CLOCK_AHEAD_MS));
  assert.equal(receiver.receive(change({ updated: [A] }), states, NOW_MS).length, 1);
});

test('state present when the page starts listening is not replayed', () => {
  const receiver = new ReactionReceiver();
  const states = new Map([[A, stateWith('🎆', 7)], [SELF, idle()]]);
  receiver.seed(states);
  states.set(A, { ...states.get(A), cursor: { x: 1, y: 1 } });
  assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS), []);
  states.set(A, stateWith('🎆', 8));
  assert.equal(receiver.receive(change({ updated: [A] }), states, NOW_MS).length, 1, 'later sends still play');
});

test('a late joiner first seen while carrying a live reaction does not play it', () => {
  const receiver = new ReactionReceiver();
  const states = new Map([[B, stateWith('❤️', 2)]]);
  assert.deepEqual(receiver.receive(change({ added: [B] }), states, NOW_MS), []);
});

test('a sender removed and seen again with its old reaction does not replay, even when reported as updated', () => {
  const { receiver, states } = receiverWithA();
  states.set(A, stateWith('🎆', 1));
  receiver.receive(change({ updated: [A] }), states, NOW_MS);
  states.delete(A);
  receiver.receive(change({ removed: [A] }), states, NOW_MS);
  states.set(A, stateWith('🎆', 1));
  // y-protocols keeps a removed peer's meta, so its return arrives in `updated`, not `added`.
  assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS + 100), []);
});

test("the page's own reaction plays locally exactly once", () => {
  const receiver = new ReactionReceiver();
  const states = new Map([[SELF, idle()]]);
  receiver.seed(states);
  states.set(SELF, stateWith('👍', 1));
  assert.deepEqual(emojis(receiver.receive(change({ updated: [SELF] }), states, NOW_MS)), [`${SELF}:👍:1`]);
  states.set(SELF, { ...states.get(SELF), view: { zoom: 1 } });
  assert.deepEqual(receiver.receive(change({ updated: [SELF] }), states, NOW_MS + 10), []);
});

test('invalid or cleared fields never play and do not disturb the next valid send', () => {
  const { receiver, states } = receiverWithA();
  for (const raw of [null, { emoji: '💩', seq: 1, at: NOW_MS }, { emoji: '👏', seq: Number.NaN, at: NOW_MS }, 'boom']) {
    states.set(A, { [BOARD_REACTION_FIELD]: raw });
    assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS), []);
  }
  states.set(A, stateWith('👏', 1));
  assert.equal(receiver.receive(change({ updated: [A] }), states, NOW_MS).length, 1);
});

test('several senders in one change each play, and the play carries the sender state', () => {
  const receiver = new ReactionReceiver();
  const states = new Map([[A, idle()], [B, idle()]]);
  receiver.seed(states);
  states.set(A, stateWith('🎆', 1));
  states.set(B, { ...stateWith('👏', 1), user: { name: 'บี' } });
  const plays = receiver.receive(change({ updated: [A, B] }), states, NOW_MS);
  assert.deepEqual(emojis(plays), [`${A}:🎆:1`, `${B}:👏:1`]);
  assert.equal(plays[1].state.user.name, 'บี');
});
