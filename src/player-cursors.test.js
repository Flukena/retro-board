import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';

import {
  cursorScreenPosition,
  mergePlayerPresence,
  normalizePlayerCursor,
  normalizePlayerView,
  playerViewFromViewport,
  readPlayerPresence,
  visiblePlayerCursors,
} from './player-cursors.js';

test('normalizes only safe finite world cursor coordinates', () => {
  assert.deepEqual(normalizePlayerCursor({ x: 120.5, y: -80, updatedAt: 5000 }), {
    x: 120.5,
    y: -80,
    updatedAt: 5000,
  });
  assert.equal(normalizePlayerCursor({ x: Infinity, y: 0, updatedAt: 5000 }), null);
  assert.equal(normalizePlayerCursor({ x: 20_000_000, y: 0, updatedAt: 5000 }), null);
  assert.equal(normalizePlayerCursor({ x: 0, y: 0, updatedAt: 0 }), null);
});

test('shows only fresh online cursors belonging to other players', () => {
  const cursors = visiblePlayerCursors({
    presence: {
      me: { userId: 'me', name: 'Me', lastSeen: 9900, cursor: { x: 1, y: 2, updatedAt: 9900 } },
      fresh: { userId: 'fresh', name: 'Alice', lastSeen: 9500, cursor: { x: 30, y: 40, updatedAt: 9800 } },
      staleCursor: { userId: 'staleCursor', name: 'Bob', lastSeen: 9900, cursor: { x: 5, y: 6, updatedAt: 1000 } },
    },
    currentUserId: 'me',
    now: 10_000,
    staleMs: 2000,
  });

  assert.deepEqual(cursors, [{
    userId: 'fresh',
    name: 'Alice',
    cursor: { x: 30, y: 40, updatedAt: 9800 },
  }]);
});

test('maps a shared world cursor into the local player viewport', () => {
  assert.deepEqual(
    cursorScreenPosition({ x: 400, y: 250 }, { x: -100, y: 50, zoom: 0.5 }),
    { x: 100, y: 175 },
  );
});

test('a live player with a delayed heartbeat keeps their fresh cursor', () => {
  const cursors = visiblePlayerCursors({
    presence: {
      alice: { userId: 'alice', lastSeen: 1000, cursor: { x: 1, y: 2, updatedAt: 20_000 } },
    },
    currentUserId: 'me',
    now: 20_000,
  });
  assert.equal(cursors.length, 1);
});

test('normalizes player view zoom and optional world center', () => {
  assert.deepEqual(normalizePlayerView({ x: 400, y: -120, zoom: 0.45, updatedAt: 5000 }), {
    x: 400,
    y: -120,
    zoom: 0.45,
    updatedAt: 5000,
  });
  assert.equal(normalizePlayerView({ zoom: Infinity, updatedAt: 5000 }), null);
  assert.equal(normalizePlayerView({ zoom: 0, updatedAt: 5000 }), null);
  assert.equal(normalizePlayerView({ zoom: 1, updatedAt: 0 }), null);
});

test('converts a viewport into its world-space center for Follow Player', () => {
  assert.deepEqual(
    playerViewFromViewport(
      { x: -300, y: 50, zoom: 0.5 },
      { w: 1200, h: 800 },
    ),
    { x: 1800, y: 700, zoom: 0.5 },
  );
});

test('merges the freshest heartbeat, cursor, and view independently across tabs', () => {
  const first = mergePlayerPresence(null, {
    userId: 'alice', name: 'Alice new name', lastSeen: 9000,
  }, { x: 10, y: 20, updatedAt: 8000 }, {
    x: 600, y: 300, zoom: 0.8, updatedAt: 9600,
  });
  const merged = mergePlayerPresence(first, {
    userId: 'alice', name: 'Alice old name', lastSeen: 7000,
  }, { x: 30, y: 40, updatedAt: 9500 }, {
    x: 900, y: 700, zoom: 1.4, updatedAt: 8500,
  });

  assert.equal(merged.name, 'Alice new name');
  assert.equal(merged.lastSeen, 9000);
  assert.deepEqual(merged.cursor, { x: 30, y: 40, updatedAt: 9500 });
  assert.deepEqual(merged.view, {
    x: 600, y: 300, zoom: 0.8, updatedAt: 9600,
  });
});


test('live awareness membership survives clock skew and renewals, and removes departed tabs', () => {
  const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
  const [first, second, receiver] = docs.map((doc) => new Awareness(doc));
  try {
    const receive = (sender) => applyAwarenessUpdate(
      receiver, encodeAwarenessUpdate(sender, [sender.clientID]), 'remote',
    );
    for (const [sender, lastSeen] of [[first, Date.now() - 60_000], [second, Date.now() + 60_000]]) {
      sender.setLocalStateField('user', { userId: 'alice', name: 'Alice', lastSeen });
      receive(sender);
    }
    assert.equal(Object.values(readPlayerPresence(receiver.getStates())).length, 1);
    // Renewal updates the protocol clock without changing user.lastSeen.
    first.setLocalState(first.getLocalState());
    receive(first);
    assert.ok(readPlayerPresence(receiver.getStates()).alice);
    first.setLocalState(null);
    receive(first);
    assert.ok(readPlayerPresence(receiver.getStates()).alice, 'second tab remains online');
    // This is the same removal primitive used by awareness expiry.
    removeAwarenessStates(receiver, [second.clientID], 'timeout');
    assert.deepEqual(Object.keys(readPlayerPresence(receiver.getStates())), []);
  } finally {
    docs.forEach((doc) => doc.destroy());
  }
});


test('Follow Player accepts five percent views and rejects views below the zoom limit', () => {
  assert.deepEqual(normalizePlayerView({ x: 400, y: 200, zoom: 0.05, updatedAt: 5000 }), {
    x: 400, y: 200, zoom: 0.05, updatedAt: 5000,
  });
  assert.equal(normalizePlayerView({ zoom: 0.04, updatedAt: 5000 }), null);
  assert.deepEqual(playerViewFromViewport({ x: 0, y: 0, zoom: 0.05 }, { w: 1200, h: 800 }), {
    x: 12000, y: 8000, zoom: 0.05,
  });
  assert.equal(playerViewFromViewport({ x: 0, y: 0, zoom: 0.04 }, { w: 1200, h: 800 }), null);
});


test('an open vote in any zone hides every remote cursor until its exact deadline', () => {
  const nowMs = 10_000;
  const presence = {
    alice: { userId: 'alice', name: 'Alice', cursor: { x: 30, y: 40, updatedAt: nowMs } },
    bob: { userId: 'bob', name: 'Bob', cursor: { x: 50, y: 60, updatedAt: nowMs } },
  };
  const options = { presence, currentUserId: 'me', now: nowMs };
  const expected = [
    { userId: 'alice', name: 'Alice', cursor: { x: 30, y: 40, updatedAt: nowMs } },
    { userId: 'bob', name: 'Bob', cursor: { x: 50, y: 60, updatedAt: nowMs } },
  ];
  const timedItems = [
    { type: 'zone' },
    { type: 'zone', voteTimer: { endsAt: nowMs - 1 } },
    { type: 'zone', voteTimer: { endsAt: nowMs + 1 } },
  ];
  assert.deepEqual(visiblePlayerCursors({ ...options, items: timedItems }), []);
  assert.deepEqual(visiblePlayerCursors({ ...options, items: timedItems, now: nowMs + 1 }), expected);
  assert.deepEqual(visiblePlayerCursors({ ...options, items: [{ type: 'zone', voteTimer: { endsAt: null } }] }), []);
  assert.deepEqual(visiblePlayerCursors({ ...options, items: [{ type: 'zone', voteTimer: { endsAt: 0 } }] }), []);
  for (const items of [[], [{ type: 'zone' }], [{ type: 'zone', voteTimer: null }],
    [{ type: 'zone', voteTimer: { endsAt: nowMs } }],
    [{ type: 'zone', voteTimer: { endsAt: nowMs - 1 } }],
    [{ type: 'sticky', voteTimer: { endsAt: nowMs + 1 } }]]) {
    assert.deepEqual(visiblePlayerCursors({ ...options, items }), expected);
  }
});
