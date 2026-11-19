import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createServer } from 'vite';
import { createZoneHeaderActions } from '../board/zone-header-actions.js';
import { PLAYER_PRESENCE_STALE_MS } from './player-cursors.js';
import { REACTION_CLEAR_MS } from '../reactions/reaction-channel.js';
import { createRoomLock } from '../room-lock/e2e-crypto.js';
import { fakeLockedRelay, LOCKED_TEST_CODE, LOCKED_TEST_HANDLE, LOCKED_TEST_TOKEN } from '../../test-support/fake-locked-relay.js';

const SESSION_TTL_MS = 60_000;
const ROOM_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const VALID_ITEM = { id: 'valid', type: 'sticky', x: 20, y: 30, text: 'Keep me', authorName: 'Alice' };
class OfflineSocket {
  close() { /* Transport fixture never opens a socket. */ }
  send() { /* Offline transport deliberately cannot deliver updates. */ }
}

const LOCK_PASSWORD = 'correct horse battery staple';
const LOCKED_EPOCH = 1;
const ROOM_KEY_CHANGED_EVENT = 'retroroom:room-key-changed';

async function unlockLockedRoom(server) {
  const { lock, authKey } = await createRoomLock(LOCK_PASSWORD);
  globalThis.fetch = fakeLockedRelay({ lock, authKey, keyEpoch: LOCKED_EPOCH }).fetch;
  const lockSession = await server.ssrLoadModule('/src/client/room-lock/lock-session.js');
  await lockSession.unlockRoom({
    code: LOCKED_TEST_CODE, token: LOCKED_TEST_TOKEN, password: LOCK_PASSWORD, lockHint: { salt: lock.salt, kdf: lock.kdf },
  });
  return lockSession;
}

async function withStorage(check, { publicWall = false, locked = false } = {}) {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const cache = new Map();
  const browser = new EventTarget();
  browser.location = new URL(publicWall ? 'http://localhost:5180/public' : 'http://localhost:5180/b/TEST#Abcdefgh12345678');
  Object.assign(globalThis, { window: browser, WebSocket: OfflineSocket });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
  } });
  globalThis.fetch = async () => new Response(JSON.stringify({
    roomHandle: ROOM_HANDLE, expiresAt: Date.now() + SESSION_TTL_MS,
  }), { headers: { 'content-type': 'application/json' } });
  const server = await createServer({ configFile: false,
    server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  let refreshTimer;
  const originalTimeout = globalThis.setTimeout;
  try {
    const session = await server.ssrLoadModule('/src/client/session/room-session.js');
    globalThis.setTimeout = (...args) => { refreshTimer = originalTimeout(...args); return refreshTimer; };
    if (publicWall) await session.establishPublicSession();
    else if (locked) await unlockLockedRoom(server);
    else await session.establishRoomSession('TEST', 'Abcdefgh12345678');
    globalThis.setTimeout = originalTimeout;
    await server.ssrLoadModule('/src/client/session/storage-bridge.js');
    await check(browser, cache, server);
  } finally {
    globalThis.setTimeout = originalTimeout;
    clearTimeout(refreshTimer);
    browser.__rbProvider?.destroy();
    browser.__rbYDoc?.destroy();
    await server.close();
    for (const key of ['window', 'WebSocket', 'localStorage', 'fetch']) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
}

function putItem(browser, item) {
  const map = new Y.Map(Object.entries(item).filter(([key]) => key !== 'id'));
  browser.__rbYItems.set(item.id, map);
}

test('remote board changes identify only canonical root item deletions and local writes do not echo', async () => {
  await withStorage(async (browser) => {
    const storage = browser.storage;
    const removedItem = { ...VALID_ITEM, id: 'removed' };
    const keptItem = { ...VALID_ITEM, id: 'kept', private: true };
    assert.equal(storage.addItems([removedItem, keptItem]), true);
    const peer = new Y.Doc();
    const changes = [];
    const onChange = ({ detail }) => { if (detail.key === 'boardState') changes.push(detail); };
    storage.on(onChange);
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(browser.__rbYDoc));
      peer.on('update', update => Y.applyUpdate(browser.__rbYDoc, update, peer));
      peer.getMap('items').delete(removedItem.id);
      assert.equal(changes.length, 1);
      assert.deepEqual([...changes.pop().deletedItemIds], [removedItem.id]);
      assert.equal(browser.__rbYItems.has(removedItem.id), false);

      peer.getMap('items').get(keptItem.id).delete('private');
      assert.equal(changes.length, 1);
      assert.deepEqual([...changes.pop().deletedItemIds], []);
      assert.equal(browser.__rbYItems.has(keptItem.id), true);

      peer.getMap('meta').set('allRevealed', true);
      assert.equal(changes.length, 1);
      assert.deepEqual([...changes.pop().deletedItemIds], []);

      assert.equal(storage.updateItem(keptItem.id, { private: true }), true);
      storage.removeItem(keptItem.id);
      assert.equal(browser.__rbYItems.has(keptItem.id), false);
      assert.equal(changes.length, 0);
    } finally {
      storage.off(onChange);
      peer.destroy();
    }
  });
});

test('gesture capture boundaries keep rapid creation, resize and next command independently undoable', async () => {
  await withStorage(async (browser) => {
    const storage = browser.storage;
    const originalSizePx = { w: 240, h: 160 };
    const resizedSizePx = { w: 320, h: 220 };
    const nextPositionPx = { x: 120, y: 150 };
    const item = { ...VALID_ITEM, ...originalSizePx };
    const readItem = async () => {
      const snapshot = (await storage.get('boardState', true)).value.items.find(({ id }) => id === item.id);
      return snapshot ? { ...snapshot } : null;
    };
    assert.equal(storage.addItem(item), true);
    storage.stopUndoCapture?.();
    assert.equal(storage.updateItem(item.id, resizedSizePx), true);
    storage.stopUndoCapture?.();
    assert.equal(storage.updateItem(item.id, nextPositionPx), true);

    assert.equal(storage.undo(), true);
    assert.deepEqual(await readItem(), { ...item, ...resizedSizePx });
    assert.equal(storage.undo(), true);
    assert.deepEqual(await readItem(), item);
    assert.equal(storage.redo(), true);
    assert.deepEqual(await readItem(), { ...item, ...resizedSizePx });
    assert.equal(storage.redo(), true);
    assert.deepEqual(await readItem(), { ...item, ...resizedSizePx, ...nextPositionPx });
  });
});

test('remote metadata cannot replace the item list', async () => {
  await withStorage(async (browser) => {
    putItem(browser, VALID_ITEM);
    browser.__rbYMeta.set('items', 5);
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    const { value } = await browser.storage.get('boardState', true);
    assert.deepEqual(value.items.map((item) => item.id), ['valid']);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
  });
});

test('remote malformed display values are excluded without changing valid items or canonical data', async () => {
  await withStorage(async (browser) => {
    putItem(browser, VALID_ITEM);
    putItem(browser, { ...VALID_ITEM, id: 'bad-text', text: {} });
    putItem(browser, { ...VALID_ITEM, id: 'bad-author', authorName: {} });
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    const { value } = await browser.storage.get('boardState', true);
    assert.deepEqual(value.items.map((item) => ({ ...item })), [VALID_ITEM]);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
  });
});

test('viewport stays local on write, cached read, cache miss and cache failure', async () => {
  await withStorage(async (browser, cache) => {
    const kv = browser.__rbYDoc.getMap('kv');
    const legacyKey = `u|${browser.__rbClientId}|viewport`;
    const viewport = { x: 40, y: 50, zoom: 2 };
    kv.set(legacyKey, { x: 0, y: 0, zoom: 1 });
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    await browser.storage.set('viewport', viewport, false);
    assert.deepEqual((await browser.storage.get('viewport', false)).value, viewport);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
    cache.clear();
    assert.equal((await browser.storage.get('viewport', false)).value, null);
    globalThis.localStorage.setItem = () => { throw new Error('quota'); };
    await browser.storage.set('viewport', viewport, false);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
  });
});

test('a normal room keeps the y-websocket provider, its URL and no encrypted-room hooks', async () => {
  await withStorage(async (browser) => {
    const provider = browser.__rbProvider;
    assert.match(provider.url, new RegExp(`/rooms/${ROOM_HANDLE}\\?awarenessId=${browser.__rbYDoc.clientID}$`));
    assert.equal(provider.pendingDelivery, undefined);
    assert.equal(browser.storage.rotationSource, undefined);
  });
});

test('an unlocked room uses the encrypted provider, tracks delivery, and clears undo on a new key epoch', async () => {
  await withStorage(async (browser) => {
    const provider = browser.__rbProvider;
    assert.match(provider.url, new RegExp(`/rooms/${ROOM_HANDLE}/e2e$`));
    assert.equal(browser.storage.addItems([VALID_ITEM]), true);
    assert.ok(provider.pendingDelivery > 0, 'the offline edit waits for an acknowledgement');
    assert.equal(browser.storage.getSyncStatus().hasUnsyncedLocalChanges, true);
    const source = browser.storage.rotationSource();
    assert.deepEqual([source.roomHandle, source.keyEpoch], [ROOM_HANDLE, LOCKED_EPOCH]);
    assert.equal(source.pendingDelivery, provider.pendingDelivery, 'the rotation can wait for delivery');
    assert.deepEqual([source.appliedSeq, source.head, source.appliedSnapshotBase], [0, 0, 0], 'offline: nothing read yet');
    const detached = new Y.Doc();
    Y.applyUpdate(detached, source.encodeState());
    assert.equal(detached.getMap('items').get(VALID_ITEM.id).get('type'), VALID_ITEM.type);
    assert.equal(browser.storage.canUndo(), true);
    browser.dispatchEvent(new CustomEvent(ROOM_KEY_CHANGED_EVENT, { detail: { keyEpoch: LOCKED_EPOCH, epochChanged: false } }));
    assert.equal(browser.storage.canUndo(), true, 'a password change keeps the history');
    browser.dispatchEvent(new CustomEvent(ROOM_KEY_CHANGED_EVENT, { detail: { keyEpoch: LOCKED_EPOCH + 1, epochChanged: true } }));
    assert.equal(browser.storage.canUndo(), false);
  }, { locked: true });
});

/** Sends one reaction through the room's channel and returns what its own subscriber heard. */
function sendOwnReaction(reactions, emoji) {
  const heard = [];
  const unsubscribe = reactions.subscribe((event) => heard.push(event.emoji));
  const sent = reactions.send(emoji);
  unsubscribe();
  return { sent, heard };
}

/** Tracks timers of exactly `delayMs` that are scheduled and neither fired nor cleared yet; `restore` unhooks it. */
function trackTimers(delayMs) {
  const pending = new Set();
  const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;
  globalThis.setTimeout = (callback, ms, ...args) => {
    const handle = realSetTimeout((...callArgs) => { pending.delete(handle); callback(...callArgs); }, ms, ...args);
    if (ms === delayMs) pending.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => { pending.delete(handle); realClearTimeout(handle); };
  return { pending, restore: () => Object.assign(globalThis, { setTimeout: realSetTimeout, clearTimeout: realClearTimeout }) };
}

test('retro boards, plain or locked, get a reaction channel that stops with the board document', async () => {
  for (const locked of [false, true]) {
    await withStorage(async (browser) => {
      const reactions = browser.storage.boardReactions;
      const clearTimers = trackTimers(REACTION_CLEAR_MS);
      try {
        assert.deepEqual(sendOwnReaction(reactions, '👏'), { sent: true, heard: ['👏'] }, `locked=${locked}`);
        assert.equal(clearTimers.pending.size, 1, 'the sent reaction is scheduled to leave presence');
        browser.__rbYDoc.destroy();
        assert.equal(clearTimers.pending.size, 0, 'destroying the board leaves nothing scheduled');
      } finally {
        clearTimers.restore();
      }
      assert.deepEqual(sendOwnReaction(reactions, '🔥'), { sent: false, heard: [] }, 'a destroyed board sends nothing');
    }, { locked });
  }
});

test('the Public Wall gets no reaction channel, so it neither shows nor plays reactions', async () => {
  await withStorage(async (browser) => {
    assert.equal(browser.storage.boardReactions, undefined);
  }, { publicWall: true });
});

test('retro boards, plain or locked, share a card-writing timer that never enters undo', async () => {
  for (const locked of [false, true]) {
    await withStorage(async (browser) => {
      const { storage } = browser;
      const timer = storage.writingTimer;
      assert.equal(timer.start(3), true, `locked=${locked}`);
      assert.equal(timer.view().label, '03:00');
      assert.equal(storage.canUndo(), false, 'starting the timer leaves nothing to undo');
      assert.equal(storage.addItem(VALID_ITEM), true);
      storage.stopUndoCapture?.();
      assert.equal(timer.extend(), true);
      assert.equal(storage.undo(), true, 'undo takes back the sticky, not the +1');
      assert.equal(browser.__rbYItems.has(VALID_ITEM.id), false);
      assert.equal(timer.view().phase, 'running');
      assert.equal(timer.view().label, '04:00');
      assert.equal(storage.redo(), true);
      assert.equal(browser.__rbYItems.has(VALID_ITEM.id), true);
      assert.equal(timer.stop(), true);
      assert.equal(storage.undo(), true, 'the sticky is still the only step');
      assert.equal(timer.view().phase, 'idle', 'undo never brings a stopped timer back');
    }, { locked });
  }
});

test('a board exported while the card-writing timer runs imports cleanly, round-trips exactly and starts no timer', async () => {
  const importedAt = Date.now();
  const transferModule = (server) => server.ssrLoadModule('/src/client/transfer/board-transfer.js');
  const boardOf = async (storage) => (await storage.get('boardState', true)).value;
  // The decoded manifest's data; the archive reader also hands back an image-reading function, and `name` is the
  // export's file name, which carries the second it was made in, so two exports can differ in it alone.
  const manifestData = (manifest) => Object.fromEntries(
    Object.entries(manifest).filter(([key, value]) => key !== 'name' && typeof value !== 'function'),
  );
  /** The export the UI downloads, read back through the import decoder, as the import dialog does. */
  const exportAndRead = async (storage, transfer) => {
    const artifact = await transfer.createBoardExport(await boardOf(storage), { boardCode: 'TEST', userId: 'alice' });
    const file = new File([artifact.blob], artifact.fileName, { type: artifact.mimeType });
    return { file, manifest: manifestData(await transfer.readBoardImport(file, importedAt)) };
  };
  let exported;
  await withStorage(async (browser, _cache, server) => {
    const { storage } = browser;
    assert.equal(storage.addItem(VALID_ITEM), true);
    const before = await boardOf(storage);
    assert.equal(storage.writingTimer.start(3), true);
    assert.deepEqual(await boardOf(storage), before, 'the running timer is not part of the board snapshot');
    exported = await exportAndRead(storage, await transferModule(server));
  });
  await withStorage(async (browser, _cache, server) => {
    const { storage } = browser;
    const transfer = await transferModule(server);
    const manifest = await transfer.readBoardImport(exported.file, importedAt);
    const board = await transfer.prepareBoardImport(manifest, await boardOf(storage));
    assert.equal(storage.importBundle(
      board, manifest.voteEntries, manifest.commentEntries, manifest.customTemplates, manifest.moodEntries,
    ), true);
    assert.equal(exported.manifest.items.length, 1);
    assert.deepEqual((await boardOf(storage)).items.map((item) => ({ ...item })), exported.manifest.items);
    assert.equal(storage.writingTimer.view().phase, 'idle', 'a restored board starts no countdown');
    assert.deepEqual((await exportAndRead(storage, transfer)).manifest, exported.manifest, 'export -> import -> export is exact');
  });
});

test('the Public Wall gets no card-writing timer', async () => {
  await withStorage(async (browser) => {
    assert.equal(browser.storage.writingTimer, undefined);
  }, { publicWall: true });
});

test('offline local changes expose status and guard unload until a socket sync', async () => {
  await withStorage(async (browser) => {
    const provider = browser.__rbProvider;
    provider.emit('status', [{ status: 'disconnected' }]);
    browser.__rbYDoc.transact(() => putItem(browser, VALID_ITEM), 'local');
    assert.equal(browser.storage.getSyncStatus?.().hasUnsyncedLocalChanges, true);
    const event = new Event('beforeunload', { cancelable: true });
    browser.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  });
});

test('finalization reads canonical votes atomically, rejects stale session and second finalizer, excludes undo', async () => {
  await withStorage(async (browser) => {
    const storage = browser.storage;
    putItem(browser, { id: 'zone', type: 'zone', x: 0, y: 0, w: 800, h: 600,
      voteTimer: { startedAt: 10, endsAt: null, voteLimit: 2, showNonVoters: true } });
    putItem(browser, { ...VALID_ITEM, parentZoneId: 'zone' });
    browser.__rbYDoc.getMap('kv').set('s||vote:valid:alice', true);
    assert.equal(storage.finalizeVoteSession('zone', 9, [], 100), null);
    const origins = [];
    browser.__rbYDoc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    const plan = storage.finalizeVoteSession('zone', 10, [{ userId: 'alice', name: 'Alice' }], 100);
    assert.equal(plan.entries.at(-1).patch.voteResults.totalVotes, 1);
    assert.equal(browser.__rbYItems.get('zone').get('voteTimer'), null);
    assert.equal(origins[0], 'system');
    assert.equal(storage.finalizeVoteSession('zone', 10, [], 101), null);
  });
});

test('session start clears root and descendant snapshots and undo restores them; finalize never enters undo', async () => {
  await withStorage(async (browser) => {
    const storage = browser.storage;
    const root = { id: 'zone', type: 'zone', x: 0, y: 0, w: 800, h: 600, voteTimer: null,
      voteResults: { historical: true }, lastResultsAt: 5 };
    putItem(browser, root);
    putItem(browser, { ...root, id: 'child', parentZoneId: 'zone', w: 400, h: 300 });
    assert.equal(storage.canUndo(), false);
    const timerPatch = { voteTimer: { startedAt: 10, endsAt: null, showNonVoters: false } };
    assert.equal(storage.startVoteSession('zone', timerPatch, ['child'], []), true);
    assert.equal(browser.__rbYItems.get('zone').get('voteResults'), null);
    assert.equal(browser.__rbYItems.get('child').get('voteResults'), null);
    assert.equal(storage.undo(), true);
    assert.deepEqual(browser.__rbYItems.get('child').get('voteResults'), { historical: true });
    assert.deepEqual(browser.__rbYItems.get('zone').get('voteResults'), { historical: true });
    assert.equal(storage.redo(), true);
    storage.finalizeVoteSession('zone', 10, [], 100);
    assert.equal(browser.__rbYItems.get('zone').get('voteResults').resultId, 'zone:10');
    storage.undo();
    assert.equal(browser.__rbYItems.get('zone').get('voteTimer'), null);
  });
});

test('finalized snapshot reaches existing peers and late joiners with a single document update', async () => {
  await withStorage(async (browser) => {
    const peer = new Y.Doc();
    const late = new Y.Doc();
    const source = browser.__rbYDoc;
    try {
      putItem(browser, { id: 'zone', type: 'zone', x: 0, y: 0, w: 800, h: 600,
        voteTimer: { startedAt: 10, endsAt: null, showNonVoters: true } });
      putItem(browser, { ...VALID_ITEM, parentZoneId: 'zone' });
      source.getMap('kv').set('s||vote:valid:alice', true);
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(source));
      let updates = 0;
      source.on('update', (update) => { updates += 1; Y.applyUpdate(peer, update); });
      browser.storage.finalizeVoteSession('zone', 10, [{ userId: 'alice', name: 'Alice' }], 100);
      assert.equal(updates, 1);
      assert.equal(peer.getMap('items').get('zone').get('voteResults').totalVotes, 1);
      assert.equal(peer.getMap('items').get('zone').get('voteTimer'), null);
      Y.applyUpdate(late, Y.encodeStateAsUpdate(source));
      assert.deepEqual(late.getMap('items').get('zone').get('voteResults'), peer.getMap('items').get('zone').get('voteResults'));
    } finally { peer.destroy(); late.destroy(); }
  });
});

test('finalization presence snapshot re-reads protocol freshness without waiting for awareness cleanup', async () => {
  await withStorage(async (browser) => {
    const awareness = browser.__rbProvider.awareness;
    const now = Date.now();
    awareness.states.set(1001, { user: { userId: 'expired', name: 'Expired slot', lastSeen: now } });
    awareness.meta.set(1001, { clock: 1, lastUpdated: now - PLAYER_PRESENCE_STALE_MS });
    awareness.states.set(1002, { user: { userId: 'idle', name: 'Connected idle user', lastSeen: 1 } });
    awareness.meta.set(1002, { clock: 1, lastUpdated: now });
    const participants = browser.storage.getPresenceSnapshot();
    assert.equal(Object.hasOwn(participants, 'expired'), false);
    assert.equal(participants.idle.name, 'Connected idle user');
  });
});

test('client result extraction ignores malformed motion and preserves deterministic duplicate name candidates', async () => {
  await withStorage(async (browser) => {
    const awareness = browser.__rbProvider.awareness;
    const finalizedAt = PLAYER_PRESENCE_STALE_MS * 2;
    const invalidNumber = JSON.parse('{"toString":null,"valueOf":null}');
    const entries = [
      [1001, { user: { userId: 'person', name: 'Zed', lastSeen: 1 }, cursor: { x: invalidNumber, y: 0, updatedAt: finalizedAt } }],
      [1002, { user: { userId: 'person', name: 'Ada', lastSeen: 1 }, view: { zoom: invalidNumber, updatedAt: finalizedAt } }],
    ];
    const finalize = (ordered) => {
      awareness.states.clear();
      ordered.forEach(([id, state]) => {
        awareness.states.set(id, state);
        awareness.meta.set(id, { clock: 1, lastUpdated: finalizedAt });
      });
      putItem(browser, { id: 'zone', type: 'zone', x: 0, y: 0, w: 800, h: 600,
        voteTimer: { startedAt: 1, endsAt: finalizedAt, showNonVoters: true } });
      const candidates = browser.storage.getVoteResultParticipants(finalizedAt);
      assert.equal(candidates.length, entries.length);
      const plan = browser.storage.finalizeVoteSession('zone', 1, candidates, finalizedAt);
      return plan.entries.at(-1).patch.voteResults;
    };
    const forward = finalize(entries);
    const reverse = finalize([...entries].reverse());
    assert.deepEqual(forward, reverse);
    assert.deepEqual(forward.participants, [{ userId: 'person', name: 'Ada', votes: 0 }]);
    assert.equal(browser.__rbYItems.get('zone').get('voteTimer'), null);
  });
});

test('geometry concealment and explicit reveal are atomic with undo and peer updates', async () => {
  await withStorage(async (browser) => {
    const source = { id: 'source', type: 'zone', x: 0, y: 0, w: 400, h: 400, revealed: false };
    const destination = { ...source, id: 'destination', x: 600, revealed: true };
    const card = { ...VALID_ITEM, private: true, authorId: 'author', parentZoneId: source.id };
    putItem(browser, source); putItem(browser, destination); putItem(browser, card);
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(browser.__rbYDoc));
      browser.__rbYDoc.on('update', update => Y.applyUpdate(peer, update));
      const storage = browser.storage;
      assert.equal(storage.updateItems([{ id: card.id, patch: { x: 620, parentZoneId: destination.id } }]), true);
      assert.equal(peer.getMap('items').get(card.id).get('revealed'), false);
      storage.undo();
      assert.equal(browser.__rbYItems.get(card.id).get('x'), card.x);
      assert.equal(browser.__rbYItems.get(card.id).has('revealed'), false);
      storage.redo();
      assert.equal(peer.getMap('items').get(card.id).get('revealed'), false);
      assert.equal(storage.updateItem(destination.id, { revealed: false }), true);
      assert.equal(browser.__rbYItems.get(card.id).get('revealed'), false);
      assert.equal(storage.updateItem(destination.id, { revealed: true }), true);
      assert.equal(peer.getMap('items').get(card.id).get('revealed'), null);
    } finally {
      peer.destroy();
    }
  });
});

test('zone additions and single-item geometry patches conceal legacy cards atomically', async () => {
  await withStorage(async (browser) => {
    const zone = { id: 'cover', type: 'zone', x: 0, y: 0, w: 400, h: 400, revealed: true };
    putItem(browser, { ...VALID_ITEM, private: true });
    assert.equal(browser.storage.addItems([zone]), true);
    assert.equal(browser.__rbYItems.get(VALID_ITEM.id).get('revealed'), false);
    assert.equal(browser.storage.updateItem(zone.id, { revealed: true }), true);
    assert.equal(browser.__rbYItems.get(VALID_ITEM.id).get('revealed'), null);
    assert.equal(browser.storage.updateItem(zone.id, { revealed: false }), true);
    browser.__rbYMeta.set('allRevealed', true);
    const SMALL_ZONE_SIZE_PX = 5;
    assert.equal(browser.storage.updateItem(zone.id, { w: SMALL_ZONE_SIZE_PX, h: SMALL_ZONE_SIZE_PX }), true);
    assert.equal(browser.__rbYItems.get(VALID_ITEM.id).get('revealed'), false);
  });
});

test('zone header reveal toggle clears descendant overrides in its updateZone transaction', async () => {
  await withStorage(async (browser) => {
    const zone = { id: 'target', type: 'zone', x: 0, y: 0, w: 400, h: 400, revealed: false };
    const card = { ...VALID_ITEM, private: true, revealed: false, parentZoneId: zone.id };
    putItem(browser, zone); putItem(browser, card);
    const context = { isAdmin: true, board: { items: [zone, card], allRevealed: false },
      updateZone: (id, patch) => browser.storage.updateItem(id, patch) };
    createZoneHeaderActions(() => context).toggleReveal(zone.id);
    assert.equal(browser.__rbYItems.get(zone.id).get('revealed'), true);
    assert.equal(browser.__rbYItems.get(card.id).get('revealed'), null);
    browser.storage.undo();
    assert.equal(browser.__rbYItems.get(zone.id).get('revealed'), false);
    assert.equal(browser.__rbYItems.get(card.id).get('revealed'), false);
  });
});

test('public image upload and backup reads use the active public relay and reject cross-room responses', async () => {
  await withStorage(async (browser, _cache, server) => {
    const imageName = '01234567-abcd.png';
    const roomPath = `/rooms/${ROOM_HANDLE}/images/${imageName}`;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options?.method });
      return new Response(JSON.stringify({ url: roomPath }), { headers: { 'content-type': 'application/json' } });
    };
    const source = await browser.storage.uploadImage(new Blob(['png'], { type: 'image/png' }));
    assert.equal(source, `http://localhost:5180/yjs-public${roomPath}`);
    assert.equal(calls[0].url, `http://localhost:5180/yjs-public/rooms/${ROOM_HANDLE}/upload`);
    const { readBackupImage } = await server.ssrLoadModule('/src/client/transfer/image-upload.js');
    globalThis.fetch = async (url) => {
      assert.equal(String(url), source);
      return new Response('public image', { headers: { 'content-type': 'image/png' } });
    };
    assert.equal(await (await readBackupImage(source)).text(), 'public image');
    globalThis.fetch = async () => new Response(JSON.stringify({ url: roomPath.replace(ROOM_HANDLE, 'z'.repeat(32)) }));
    await assert.rejects(browser.storage.uploadImage(new Blob(['png'], { type: 'image/png' })), /invalid image upload URL/);
  }, { publicWall: true });
});

test('private image uploads retain their existing relay and authenticated room scope', async () => {
  await withStorage(async (browser) => {
    const path = `/rooms/${ROOM_HANDLE}/images/01234567-abcd.png`;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), `http://localhost:1234/rooms/${ROOM_HANDLE}/upload`);
      return new Response(JSON.stringify({ url: path }));
    };
    const source = await browser.storage.uploadImage(new Blob(['png'], { type: 'image/png' }));
    assert.equal(source, `http://localhost:1234${path}`);
  });
});


test('image upload forwards cancellation to its authenticated request without adding board items', async () => {
  await withStorage(async browser => {
    const controller = new AbortController();
    let receivedSignal;
    globalThis.fetch = async (_url, options) => {
      receivedSignal = options.signal;
      throw new DOMException('cancelled', 'AbortError');
    };
    await assert.rejects(browser.storage.uploadImage(new Blob(['png'], { type: 'image/png' }), { signal: controller.signal }));
    assert.equal(receivedSignal, controller.signal);
  });
});

test('Public creation quota rejects a repeated paste before mutating Yjs, while deletion and edits remain available', async () => {
  await withStorage(async (browser) => {
    const notices = [];
    browser.addEventListener('retro-public-creation-limit', event => notices.push(event.detail));
    const initial = Array.from({ length: 10 }, (_, index) => ({ ...VALID_ITEM, id: `quota-${index}` }));
    assert.equal(browser.storage.addItems(initial), true);
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    assert.equal(browser.storage.addItem({ ...VALID_ITEM, id: 'quota-over' }), false);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
    assert.equal(notices.length, 1);
    assert.ok(notices[0].retryAfterSeconds > 0);
    browser.storage.removeItem('quota-0');
    assert.equal(browser.storage.updateItem('quota-1', { x: 40 }), true);
    assert.equal(browser.__rbYItems.has('quota-0'), false);
    assert.equal(browser.__rbYItems.get('quota-1').get('x'), 40);
  }, { publicWall: true });
});

test('Public image quota rejects a second image without spending additional item capacity', async () => {
  await withStorage(async browser => {
    const image = { id: 'first-image', type: 'image', x: 0, y: 0, w: 100, h: 100 };
    assert.equal(browser.storage.canCreateItems([{ type: 'image' }]), true);
    assert.equal(browser.storage.addItem(image), true);
    assert.equal(browser.storage.canCreateItems([{ type: 'image' }]), false);
    assert.equal(browser.storage.consumePublicCreationFailure(), true);
    assert.equal(browser.storage.addItem({ ...image, id: 'second-image' }), false);
    assert.equal(browser.storage.addItem({ ...VALID_ITEM, id: 'ordinary-item' }), true);
    assert.equal(browser.__rbYItems.has('second-image'), false);
  }, { publicWall: true });
});

test('Public board replacement and import refuse oversized additions atomically, but clearing remains allowed', async () => {
  await withStorage(async browser => {
    const items = Array.from({ length: 11 }, (_, index) => ({ ...VALID_ITEM, id: `batch-${index}` }));
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    assert.equal(browser.storage.replaceBoard({ items }), false);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
    assert.equal(browser.storage.importBundle({ items }, [], [], null), false);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
    assert.equal(browser.storage.addItem({ ...VALID_ITEM, id: 'remove-me' }), true);
    assert.equal(browser.storage.replaceBoard({ items: [] }), true);
    assert.equal(browser.__rbYItems.size, 0);
  }, { publicWall: true });
});

test('creation is blocked after server quota rejection, but private rooms are unaffected', async () => {
  await withStorage(async browser => {
    browser.__rbProvider.emit('connection-close', [{ code: 1008, reason: 'public action limit' }]);
    assert.equal(browser.storage.addItem({ ...VALID_ITEM, id: 'not-shared' }), false);
    assert.equal(browser.__rbYItems.has('not-shared'), false);
  }, { publicWall: true });
  await withStorage(async browser => {
    const items = Array.from({ length: 11 }, (_, index) => ({ ...VALID_ITEM, id: `private-${index}` }));
    assert.equal(browser.storage.addItems(items), true);
  });
});

test('mood answers sync per person, undo only the own answer, and are replaced by import', async () => {
  await withStorage(async browser => {
    const storage = browser.storage;
    let changes = 0;
    storage.onMoodsChange(() => { changes += 1; });
    assert.equal(storage.setMood('round1', 'alice', 4), true);
    storage.stopUndoCapture();
    assert.equal(storage.setMood('round1', 'bob', 2), true);
    for (const bad of [['round1', 'alice', 0], ['round1', 'alice', 6], ['bad id', 'alice', 3], ['round1', 'a:b', 3]]) {
      assert.equal(storage.setMood(...bad), false, JSON.stringify(bad));
    }
    assert.deepEqual(storage.snapshotMoods().map(({ userId, score }) => [userId, score]).sort(), [['alice', 4], ['bob', 2]]);
    assert.ok(changes >= 2);
    storage.undo();
    assert.deepEqual(storage.snapshotMoods().map(({ userId }) => userId), ['alice']);
    storage.stopUndoCapture();
    storage.clearAllMoods();
    assert.deepEqual(storage.snapshotMoods(), []);
    storage.undo();
    assert.deepEqual(storage.snapshotMoods(), [], 'starting a new round is not undoable');
    storage.setMood('old', 'carol', 1);
    const answers = [{ roundId: 'round2', userId: 'dan', score: 5 }];
    assert.equal(storage.importBundle({ items: [] }, [], [], null, answers), true);
    assert.deepEqual(storage.snapshotMoods(), answers);
    assert.equal(storage.importBundle({ items: [] }, [], [], null, [{ ...answers[0], score: 9 }]), false);
    assert.deepEqual(storage.snapshotMoods(), answers);
  });
});

const IMAGE_MARKER = 'SECRET-PIXELS-MARKER';
const pngBlob = () => new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), IMAGE_MARKER], { type: 'image/png' });
const BLOB_UPLOAD_SUFFIX = '/e2e-blobs';

test('a locked room encrypts every image upload at the shared boundary and never calls the plaintext route', async () => {
  await withStorage(async (browser) => {
    const sent = [];
    const relaySession = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith(BLOB_UPLOAD_SUFFIX)) {
        sent.push({ url: String(url), headers: new Headers(init.headers), body: Buffer.from(init.body) });
        return new Response(JSON.stringify({ id: sent.at(-1).headers.get('x-blob-id') }), { status: 201 });
      }
      if (String(url).endsWith('/upload')) sent.push({ url: String(url), body: Buffer.from('plaintext route used') });
      return relaySession(url, init);
    };
    const src = await browser.storage.uploadImage(pngBlob());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, `http://localhost:1234/rooms/${LOCKED_TEST_HANDLE}${BLOB_UPLOAD_SUFFIX}`);
    assert.equal(sent[0].body.includes(Buffer.from(IMAGE_MARKER)), false, 'the image bytes are not in the request');
    assert.equal(src, `/rooms/${LOCKED_TEST_HANDLE}/e2e-blobs/${sent[0].headers.get('x-blob-id')}`);
  }, { locked: true });
});

test('image repair rewrites sources locally without creating an undo step', async () => {
  await withStorage(async (browser) => {
    const before = `/rooms/${ROOM_HANDLE}/e2e-blobs/3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b`;
    const after = `/rooms/${ROOM_HANDLE}/e2e-blobs/4f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b`;
    browser.__rbYDoc.transact(() => putItem(browser, { id: 'img', type: 'image', x: 0, y: 0, w: 10, h: 10, src: before }), 'system');
    assert.equal(browser.storage.canUndo(), false);
    assert.deepEqual(browser.storage.listImageSources(), [{ id: 'img', src: before }]);
    assert.equal(browser.storage.rewriteImageSources(new Map([[before, after]])), 1);
    assert.deepEqual(browser.storage.listImageSources(), [{ id: 'img', src: after }]);
    assert.equal(browser.storage.canUndo(), false, 'a repair is not an undo step');
  }, { locked: true });
});

test('a normal room refuses the image rewrite', async () => {
  await withStorage(async (browser) => {
    assert.throws(() => browser.storage.rewriteImageSources(new Map()), RangeError);
  });
});

const LOCKED_BLOB_ROUTE = /\/e2e-blobs$/;
const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

// Records what leaves the browser for blob uploads; the session exchange still answers from the room fake.
function captureBlobUploads() {
  const sent = [];
  const relaySession = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (LOCKED_BLOB_ROUTE.test(String(url))) {
      sent.push(Buffer.from(init.body));
      return new Response(JSON.stringify({ id: new Headers(init.headers).get('x-blob-id') }), { status: 201 });
    }
    if (String(url).endsWith('/upload')) sent.push(Buffer.from('plaintext route used'));
    return relaySession(url, init);
  };
  return sent;
}

test('paste, file and drop uploads (uploadWithRetry) send only ciphertext in a locked room', async () => {
  await withStorage(async (_browser, _cache, server) => {
    const sent = captureBlobUploads();
    const { uploadWithRetry } = await server.ssrLoadModule('/src/client/transfer/image-upload.js');
    const src = await uploadWithRetry(pngBlob());
    assert.match(src, /\/e2e-blobs\//);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].includes(Buffer.from(IMAGE_MARKER)), false);
  }, { locked: true });
});

test('successive drawing checkpoints keep saving through the encrypted upload boundary', async () => {
  await withStorage(async (browser, _cache, server) => {
    const sent = captureBlobUploads();
    const { uploadWithRetry } = await server.ssrLoadModule('/src/client/transfer/image-upload.js');
    const { saveDrawingArtifact } = await server.ssrLoadModule('/src/client/board/drawing-save.js');
    const artifact = { blob: pngBlob(), bounds: { x: 10, y: 20, w: 100, h: 80 }, natW: 100, natH: 80 };
    let created = 0;
    const operations = {
      isCurrent: () => true, canEdit: () => true, canCreateImage: () => true, uploadFailed: () => assert.fail('upload failed'),
      uploadImage: (blob) => uploadWithRetry(blob), author: () => ({ authorId: 'a', authorName: 'Ada' }),
      createId: () => `drawing-${created++}`, now: () => 1000, items: () => Array.from(browser.__rbYItems, ([id, item]) => ({ id, ...item.toJSON() })),
      stopUndoCapture: () => {}, addItem: (item) => browser.storage.addItem(item),
      updateItem: (id, patch) => browser.storage.updateItem(id, patch), selectItem: () => {},
    };
    assert.equal(await saveDrawingArtifact(artifact, operations), true);
    const [first] = operations.items();
    assert.match(first.src, /\/e2e-blobs\//);
    for (let checkpoint = 0; checkpoint < 2; checkpoint += 1) {
      const [current] = operations.items();
      assert.equal(await saveDrawingArtifact(artifact, operations, current), true, `checkpoint ${checkpoint + 2}`);
    }
    assert.equal(sent.length, 3);
    assert.equal(sent.some((body) => body.includes(Buffer.from(IMAGE_MARKER))), false);
    assert.notEqual(operations.items()[0].src, first.src);
  }, { locked: true });
});

test('production import (sanitizeImportedImages with prepareImageBlob) re-encrypts a GIF into the locked room', async () => {
  await withStorage(async (browser, _cache, server) => {
    const sent = captureBlobUploads();
    const saved = { Image: globalThis.Image };
    globalThis.Image = class {
      naturalWidth = 1;
      naturalHeight = 1;
      set src(value) { queueMicrotask(() => this.onload()); }
    };
    try {
      const { sanitizeImportedImages } = await server.ssrLoadModule('/src/client/transfer/image-upload.js');
      const items = [{ id: 'g', type: 'image', x: 0, y: 0, w: 10, h: 10, src: `data:image/gif;base64,${GIF_BASE64}` }];
      const [restored] = await sanitizeImportedImages(items);
      assert.match(restored.src, /\/e2e-blobs\//);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].includes(Buffer.from('GIF89a')), false, 'the GIF bytes are not in the request');
    } finally {
      if (saved.Image === undefined) delete globalThis.Image; else globalThis.Image = saved.Image;
    }
  }, { locked: true });
});

test('the image rewrite is for locked rooms and only accepts canonical encrypted sources of that room', async () => {
  await withStorage(async (browser) => {
    const own = (id) => `/rooms/${LOCKED_TEST_HANDLE}/e2e-blobs/${id}`;
    const before = own('3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b');
    browser.__rbYDoc.transact(() => putItem(browser, { id: 'img', type: 'image', x: 0, y: 0, w: 10, h: 10, src: before }), 'system');
    assert.throws(() => browser.storage.rewriteImageSources(new Map([[before, 'javascript:alert(1)']])), RangeError);
    assert.throws(() => browser.storage.rewriteImageSources(new Map([[before, `/rooms/${'z'.repeat(32)}/e2e-blobs/4f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b`]])), RangeError);
    assert.equal(browser.storage.rewriteImageSources(new Map([[before, own('4f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b')]])), 1);
  }, { locked: true });
});
