import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createServer } from 'vite';
import { createZoneHeaderActions } from '../board/zone-header-actions.js';
import { PLAYER_PRESENCE_STALE_MS } from './player-cursors.js';

const SESSION_TTL_MS = 60_000;
const ROOM_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const VALID_ITEM = { id: 'valid', type: 'sticky', x: 20, y: 30, text: 'Keep me', authorName: 'Alice' };
class OfflineSocket {
  close() { /* Transport fixture never opens a socket. */ }
  send() { /* Offline transport deliberately cannot deliver updates. */ }
}

async function withStorage(check, { publicWall = false } = {}) {
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
