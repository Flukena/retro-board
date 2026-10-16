import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createServer } from 'vite';
import { PLAYER_PRESENCE_STALE_MS } from './player-cursors.js';

const SESSION_TTL_MS = 60_000;
const ROOM_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const VALID_ITEM = { id: 'valid', type: 'sticky', x: 20, y: 30, text: 'Keep me', authorName: 'Alice' };
class OfflineSocket {
  close() { /* Transport fixture never opens a socket. */ }
  send() { /* Offline transport deliberately cannot deliver updates. */ }
}

async function withStorage(check) {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const cache = new Map();
  const browser = new EventTarget();
  browser.location = new URL('http://localhost:5180/b/TEST#Abcdefgh12345678');
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
    const session = await server.ssrLoadModule('/src/room-session.js');
    globalThis.setTimeout = (...args) => { refreshTimer = originalTimeout(...args); return refreshTimer; };
    await session.establishRoomSession('TEST', 'Abcdefgh12345678');
    globalThis.setTimeout = originalTimeout;
    await server.ssrLoadModule('/src/storage-bridge.js');
    await check(browser, cache);
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
