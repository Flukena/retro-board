import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';

import { createStoryUndoManager, initPokerRoom } from './poker-actions.js';
import { createPokerRoomStore } from './poker-room-store.js';
import { POKER_REACTIONS, POKER_REACTION_COOLDOWN_MS, POKER_REACTION_TTL_MS } from '../../domain/poker-reactions.js';

const NOW_MS = 1_700_000_000_000;

function participant(context, userId, userName) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const undoManager = createStoryUndoManager(doc);
  let next = 0;
  const store = createPokerRoomStore({ doc, awareness, undoManager }, { userId, userName }, {
    now: () => NOW_MS,
    createId: () => { next += 1; return `${userId}-story${next}`; },
  });
  context.after(() => { store.destroy(); undoManager.destroy(); awareness.destroy(); doc.destroy(); });
  return { doc, awareness, store };
}

function link(a, b) {
  for (const [from, to] of [[a, b], [b, a]]) {
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc), 'peer');
    from.doc.on('update', (update, origin) => { if (origin !== 'peer') Y.applyUpdate(to.doc, update, 'peer'); });
    const sendAwareness = ({ added, updated, removed }, origin) => {
      if (origin === 'peer') return;
      applyAwarenessUpdate(to.awareness, encodeAwarenessUpdate(from.awareness, [...added, ...updated, ...removed]), 'peer');
    };
    from.awareness.on('update', sendAwareness);
    sendAwareness({ added: [from.doc.clientID], updated: [], removed: [] });
  }
}

test('both participants see each other by name and votes stay face down until reveal', (context) => {
  const alice = participant(context, 'alice', 'Alice');
  const bob = participant(context, 'bob', 'Bob');
  link(alice, bob);
  initPokerRoom(alice.doc);
  alice.store.addStories(['Checkout']);
  assert.deepEqual(Object.fromEntries(bob.store.getSnapshot().names), { alice: 'Alice', bob: 'Bob' });
  alice.store.vote('5');
  bob.store.vote('8');
  const { room } = bob.store.getSnapshot();
  assert.deepEqual(Object.fromEntries(room.votesByStory.get(room.activeStoryId)), { alice: '5', bob: '8' });
  alice.store.reveal();
  assert.equal(bob.store.getSnapshot().room.stories[0].revealedAt, NOW_MS);
});

test('subscribers are notified on remote changes and snapshots are replaced, not mutated', (context) => {
  const alice = participant(context, 'alice', 'Alice');
  const bob = participant(context, 'bob', 'Bob');
  link(alice, bob);
  initPokerRoom(alice.doc);
  let calls = 0;
  bob.store.subscribe(() => { calls += 1; });
  const before = bob.store.getSnapshot();
  alice.store.addStories(['A']);
  assert.ok(calls > 0);
  assert.notEqual(bob.store.getSnapshot(), before);
  assert.equal(before.room.stories.length, 0);
});

test('next story moves to the following unestimated story', (context) => {
  const alice = participant(context, 'alice', 'Alice');
  initPokerRoom(alice.doc);
  const [first, , third] = alice.store.addStories(['A', 'B', 'C']);
  alice.store.vote('3');
  alice.store.reveal();
  alice.store.acceptEstimate('3');
  alice.store.selectStory(alice.store.getSnapshot().room.stories[1].id);
  alice.store.acceptEstimate('5');
  alice.store.nextStory();
  assert.equal(alice.store.getSnapshot().room.activeStoryId, third);
  alice.store.nextStory();
  assert.equal(alice.store.getSnapshot().room.activeStoryId, third, 'no other unestimated story: stay');
  assert.notEqual(first, third);
});

test('undo availability is published for story edits only', (context) => {
  const alice = participant(context, 'alice', 'Alice');
  initPokerRoom(alice.doc);
  assert.equal(alice.store.getSnapshot().canUndo, false);
  const [storyId] = alice.store.addStories(['Draft']);
  assert.equal(alice.store.getSnapshot().canUndo, true);
  alice.store.undo();
  assert.equal(alice.store.getSnapshot().room.stories.length, 0);
  assert.equal(alice.store.getSnapshot().canRedo, true);
  alice.store.redo();
  assert.equal(alice.store.getSnapshot().room.stories[0].id, storyId);
});

test('a room holding board items is reported so it is not claimed as poker', (context) => {
  const alice = participant(context, 'alice', 'Alice');
  assert.equal(alice.store.getSnapshot().hasBoardContent, false);
  alice.store.claimRoom();
  assert.equal(alice.store.getSnapshot().room.isPoker, true);
  alice.doc.getMap('items').set('sticky1', new Y.Map());
  assert.equal(alice.store.getSnapshot().hasBoardContent, true);
});

test('an empty board that a board client already opened is still a board', (context) => {
  const alice = participant(context, 'alice', 'Alice');
  alice.doc.getMap('meta').set('__roomRegistered', 1);
  assert.equal(alice.store.getSnapshot().hasBoardContent, false, 'the relay seed alone is not a board');
  alice.doc.getMap('meta').set('__migrated', true);
  assert.equal(alice.store.getSnapshot().hasBoardContent, true);
});

test('a participant without a name is not announced until they pick one', (context) => {
  const alice = participant(context, 'alice', '');
  assert.equal(alice.awareness.getLocalState()?.user, undefined);
  alice.store.setName('Alice');
  assert.equal(alice.awareness.getLocalState().user.name, 'Alice');
});

function timedParticipant(context, userId, userName, clock) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const undoManager = createStoryUndoManager(doc);
  const store = createPokerRoomStore({ doc, awareness, undoManager }, { userId, userName }, {
    now: () => clock.now,
    createId: () => `${userId}-story`,
    setTimer: (callback, delayMs) => { clock.timers.push({ callback, dueAt: clock.now + delayMs }); return clock.timers.length; },
    clearTimer: () => {},
  });
  context.after(() => { store.destroy(); undoManager.destroy(); awareness.destroy(); doc.destroy(); });
  return { doc, awareness, store };
}

function advance(clock, ms) {
  clock.now += ms;
  for (const timer of clock.timers.filter(({ dueAt }) => dueAt <= clock.now)) timer.callback();
  clock.timers = clock.timers.filter(({ dueAt }) => dueAt > clock.now);
}

test('a reaction appears on the target seat for both participants and clears itself', (context) => {
  const clock = { now: NOW_MS, timers: [] };
  const alice = timedParticipant(context, 'alice', 'Alice', clock);
  const bob = timedParticipant(context, 'bob', 'Bob', clock);
  link(alice, bob);
  alice.store.react('bob', POKER_REACTIONS[0]);
  for (const viewer of [alice, bob]) {
    const onBob = viewer.store.getSnapshot().reactions.get('bob');
    assert.deepEqual(onBob.map(({ emoji, fromUserId }) => [emoji, fromUserId]), [[POKER_REACTIONS[0], 'alice']]);
  }
  advance(clock, POKER_REACTION_TTL_MS);
  assert.equal(bob.store.getSnapshot().reactions.size, 0, 'gone after the TTL');
});

test('reactions inside the cooldown are ignored, then allowed again', (context) => {
  const clock = { now: NOW_MS, timers: [] };
  const alice = timedParticipant(context, 'alice', 'Alice', clock);
  const bob = timedParticipant(context, 'bob', 'Bob', clock);
  link(alice, bob);
  alice.store.react('bob', POKER_REACTIONS[0]);
  alice.store.react('bob', POKER_REACTIONS[1]);
  assert.equal(bob.store.getSnapshot().reactions.get('bob')[0].emoji, POKER_REACTIONS[0]);
  advance(clock, POKER_REACTION_COOLDOWN_MS);
  alice.store.react('bob', POKER_REACTIONS[1]);
  assert.equal(bob.store.getSnapshot().reactions.get('bob')[0].emoji, POKER_REACTIONS[1]);
});
