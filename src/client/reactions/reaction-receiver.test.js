import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_REACTION_FIELD, REACTION_SEND_INTERVAL_MS, boardReaction } from '../../domain/board-reactions.js';
import { MAX_PLAYS_PER_ADMISSION_WINDOW, REACTION_ADMISSION_WINDOW_MS, ReactionReceiver } from './reaction-receiver.js';

// The receiver's own clock (monotonic page time); senders' clocks never reach it.
const NOW_MS = 500_000;
const A = 11;
const B = 22;
const SELF = 33;
const NO_CHANGE = Object.freeze({ added: [], updated: [], removed: [] });
const BYPASS_UPDATES = 20;
const SENDER_CLOCK_BEHIND_MS = 11_000;
const SENDER_CLOCK_AHEAD_MS = 60_000;

const stateWith = (emoji, seq) => ({ user: { name: 'Ada' }, [BOARD_REACTION_FIELD]: boardReaction(emoji, seq) });
const idle = () => ({ user: { name: 'Ada' } });
const change = (patch) => ({ ...NO_CHANGE, ...patch });
const emojis = (plays) => plays.map(({ clientId, reaction }) => `${clientId}:${reaction.emoji}:${reaction.seq}`);

/** A receiver that has already seen the given senders without a reaction. */
function receiverWith(...clientIds) {
  const receiver = new ReactionReceiver();
  const states = new Map(clientIds.map((clientId) => [clientId, idle()]));
  receiver.seed(states);
  return { receiver, states };
}

/** Sets `clientId`'s presence reaction and returns what the receiver plays at `now`. */
function react({ receiver, states }, clientId, emoji, seq, now) {
  states.set(clientId, stateWith(emoji, seq));
  return receiver.receive(change({ updated: [clientId] }), states, now);
}

test('a new seq from a known sender plays once, even when other presence fields keep changing', () => {
  const page = receiverWith(A);
  assert.deepEqual(emojis(react(page, A, '🎆', 1, NOW_MS)), [`${A}:🎆:1`]);
  page.states.set(A, { ...page.states.get(A), cursor: { x: 5, y: 5 } });
  assert.deepEqual(page.receiver.receive(change({ updated: [A] }), page.states, NOW_MS + 50), [], 'cursor churn');
  page.states.set(A, { ...page.states.get(A), selectedItems: ['card'] });
  assert.deepEqual(page.receiver.receive(change({ updated: [A] }), page.states, NOW_MS + 90), [], 'selection churn');
});

test('the next send an interval later plays again; an older seq never replays', () => {
  const page = receiverWith(A);
  react(page, A, '👏', 4, NOW_MS);
  assert.deepEqual(emojis(react(page, A, '🔥', 5, NOW_MS + REACTION_SEND_INTERVAL_MS)), [`${A}:🔥:5`]);
  assert.deepEqual(react(page, A, '👏', 4, NOW_MS + 2 * REACTION_SEND_INTERVAL_MS), []);
});

test('a peer that bypasses send() is held to one play per interval on this page, and skipped seqs never replay', () => {
  const page = receiverWith(A);
  let played = 0;
  for (let seq = 1; seq <= BYPASS_UPDATES; seq += 1) played += react(page, A, '🎆', seq, NOW_MS + seq).length;
  assert.equal(played, 1, `${BYPASS_UPDATES} immediate updates`);
  page.states.set(A, { ...page.states.get(A), cursor: { x: 1, y: 1 } });
  const later = NOW_MS + 2 * REACTION_SEND_INTERVAL_MS;
  assert.deepEqual(page.receiver.receive(change({ updated: [A] }), page.states, later), [],
    'the last skipped seq, re-broadcast after the cooldown, is already consumed');
  assert.equal(react(page, A, '🎆', BYPASS_UPDATES + 1, later).length, 1, 'a genuinely new send plays again');
});

test('a sender that leaves and returns inside its cooldown does not play early', () => {
  const page = receiverWith(A);
  react(page, A, '🎆', 1, NOW_MS);
  page.states.delete(A);
  page.receiver.receive(change({ removed: [A] }), page.states, NOW_MS + 1);
  page.states.set(A, idle());
  page.receiver.receive(change({ added: [A] }), page.states, NOW_MS + 2);
  assert.deepEqual(react(page, A, '🎆', 2, NOW_MS + 3), [], 'still cooling down after rejoining');
  assert.equal(react(page, A, '🎆', 3, NOW_MS + REACTION_SEND_INTERVAL_MS).length, 1);
});

test('many senders at once (or one peer churning identities) play at most the shared budget per window', () => {
  const senders = Array.from({ length: MAX_PLAYS_PER_ADMISSION_WINDOW + 3 }, (_, index) => 100 + index);
  const page = receiverWith(...senders);
  let played = 0;
  for (const clientId of senders) played += react(page, clientId, '👏', 1, NOW_MS).length;
  assert.equal(played, MAX_PLAYS_PER_ADMISSION_WINDOW);
  const late = senders.at(-1);
  assert.equal(react(page, late, '👏', 2, NOW_MS + REACTION_ADMISSION_WINDOW_MS).length, 1,
    'a sender held back by the shared budget plays again once the window has passed');
});

test('sender clocks play no part: a sender 11 s behind or a minute ahead still plays', () => {
  const page = receiverWith(A, B);
  page.states.set(A, { [BOARD_REACTION_FIELD]: { emoji: '👏', seq: 1, at: NOW_MS - SENDER_CLOCK_BEHIND_MS } });
  page.states.set(B, { [BOARD_REACTION_FIELD]: { emoji: '😂', seq: 1, at: NOW_MS + SENDER_CLOCK_AHEAD_MS } });
  assert.deepEqual(emojis(page.receiver.receive(change({ updated: [A, B] }), page.states, NOW_MS)), [`${A}:👏:1`, `${B}:😂:1`]);
});

test('state present when the page starts listening is not replayed', () => {
  const receiver = new ReactionReceiver();
  const states = new Map([[A, stateWith('🎆', 7)], [SELF, idle()]]);
  receiver.seed(states);
  states.set(A, { ...states.get(A), cursor: { x: 1, y: 1 } });
  assert.deepEqual(receiver.receive(change({ updated: [A] }), states, NOW_MS), []);
  assert.equal(react({ receiver, states }, A, '🎆', 8, NOW_MS).length, 1, 'later sends still play');
});

test('a late joiner first seen while carrying a live reaction does not play it', () => {
  const receiver = new ReactionReceiver();
  const states = new Map([[B, stateWith('❤️', 2)]]);
  assert.deepEqual(receiver.receive(change({ added: [B] }), states, NOW_MS), []);
});

test('a sender removed and seen again with its old reaction does not replay, even when reported as updated', () => {
  const page = receiverWith(A);
  react(page, A, '🎆', 1, NOW_MS);
  page.states.delete(A);
  page.receiver.receive(change({ removed: [A] }), page.states, NOW_MS);
  // y-protocols keeps a removed peer's meta, so its return arrives in `updated`, not `added`.
  assert.deepEqual(react(page, A, '🎆', 1, NOW_MS + 2 * REACTION_SEND_INTERVAL_MS), []);
});

test("the page's own reaction plays locally exactly once", () => {
  const page = receiverWith(SELF);
  assert.deepEqual(emojis(react(page, SELF, '👍', 1, NOW_MS)), [`${SELF}:👍:1`]);
  page.states.set(SELF, { ...page.states.get(SELF), view: { zoom: 1 } });
  assert.deepEqual(page.receiver.receive(change({ updated: [SELF] }), page.states, NOW_MS + 10), []);
});

test('invalid or cleared fields never play and do not disturb the next valid send', () => {
  const page = receiverWith(A);
  for (const raw of [null, { emoji: '💩', seq: 1 }, { emoji: '👏', seq: Number.NaN }, 'boom']) {
    page.states.set(A, { [BOARD_REACTION_FIELD]: raw });
    assert.deepEqual(page.receiver.receive(change({ updated: [A] }), page.states, NOW_MS), []);
  }
  assert.equal(react(page, A, '👏', 1, NOW_MS).length, 1);
});

test('several senders in one change each play, and the play carries the sender state', () => {
  const page = receiverWith(A, B);
  page.states.set(A, stateWith('🎆', 1));
  page.states.set(B, { ...stateWith('👏', 1), user: { name: 'บี' } });
  const plays = page.receiver.receive(change({ updated: [A, B] }), page.states, NOW_MS);
  assert.deepEqual(emojis(plays), [`${A}:🎆:1`, `${B}:👏:1`]);
  assert.equal(plays[1].state.user.name, 'บี');
});
