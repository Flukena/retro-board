// Deliberate freeze contract for the `window.storage` seam: a refactor-safety net for the P1+ moves out
// of storage-bridge.js, not a behaviour spec. The refactor design
// (docs/superpowers/specs/2026-11-19-codebase-refactor-design.md, anti-goals) freezes window.storage
// method names and arity on every route, so BOARD_KEYS, LANDING_KEYS and the arity table are derived
// from the current code on purpose. A red test here is a contract change that needs its own decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, productionSources } from '../../../scripts/project-files.mjs';
import { withStorage } from '../../test-support/bridge-harness.js';

// `storage.x`, `storage?.x` and `window.storage.x`. Case-sensitive, so `localStorage`/`sessionStorage` never match.
const STORAGE_MEMBER_PATTERN = /(?<![A-Za-z])(?:window\.)?storage\??\.([A-Za-z]+)/g;
const RETRO_BOARD_SOURCE = 'RetroBoard.jsx';
const CLIENT_SOURCE_PREFIX = 'src/client/';
// The producer: its own `window.storage.x = ...` assignments would make any new member look consumed.
const STORAGE_PRODUCER_SOURCE = 'src/client/session/storage-bridge.js';

// Scan hits that are not window.storage members.
const NOT_STORAGE_MEMBERS = Object.freeze({
  getItem: 'Web Storage on an injected localStorage-like `storage` parameter '
    + '(signed-in-hint, drawing-preferences, pending-starter, vote-results-dismissal)',
  setItem: 'Web Storage on the same injected `storage` parameters as getItem',
  js: 'the `./src/client/session/room-storage.js` import path in RetroBoard.jsx',
});

// Members only a locked (end-to-end encrypted) room has.
const LOCKED_ONLY_KEYS = Object.freeze(['rotationSource']);
// storage-bridge.js: "Emoji reactions and the card-writing timer are for retro boards only: the Public Wall gets neither."
const RETRO_ONLY_KEYS = Object.freeze(['boardReactions', 'writingTimer']);

// Board-route members that no scanned client file reads.
const NO_CONSUMER_REASON = 'no consumer in RetroBoard.jsx, src/client, the scripts/*-live-check.mjs e2e hooks or poker '
  + '(rg, 2026-11-19); kept only because the refactor design freezes window.storage names and arity';
const UNCONSUMED_BUT_FROZEN = Object.freeze({
  clearVotesForItems: NO_CONSUMER_REASON,
  editComment: NO_CONSUMER_REASON,
});

// The no-op stub the bridge installs when loaded off a board or the Public Wall (here: the home page).
const LANDING_KEYS = Object.freeze([
  'get', 'set', 'snapshotTemplates', 'putTemplate', 'removeTemplate', 'onTemplatesChange', 'offTemplatesChange',
  'on', 'off', 'setLocalBusyItems', 'findRemoteBusyItem', 'getRemoteBusyItems', 'onBusyChange', 'offBusyChange',
  'getRemoteEditingItems', 'onEditingChange', 'offEditingChange', 'setLocalSelectedItems', 'getRemoteSelectedItems',
  'onSelectionChange', 'offSelectionChange', 'getPresenceSnapshot', 'onPresenceChange', 'offPresenceChange',
  'setLocalCursor', 'setLocalView',
]);
// What the stub's read methods answer: nothing, in the shape each board method returns.
const LANDING_STUB_RESULTS = Object.freeze({
  snapshotTemplates: [],
  putTemplate: false,
  removeTemplate: false,
  findRemoteBusyItem: null,
  getRemoteBusyItems: new Map(),
  getRemoteEditingItems: new Map(),
  getRemoteSelectedItems: new Map(),
  getPresenceSnapshot: {},
});
// Subscriptions that hand back an unsubscribe function, as on the board route.
const LANDING_UNSUBSCRIBE_METHODS = Object.freeze(['onBusyChange', 'onEditingChange', 'onSelectionChange', 'onPresenceChange']);

// Board members that are objects, not methods. Named here because the arity table pins only method names.
const BOARD_OBJECT_MEMBERS = Object.freeze(['boardReactions', 'drawingPreviews', 'writingTimer']);

// Function.length of each board-route method, in storage-bridge.js order. A default parameter ends the count
// (getVoteResultParticipants 0, uploadImage 1, importBundle 4). getSyncStatus and onSyncStatus are the
// SyncStatus getSnapshot/subscribe fields (sync-status.js); setLocalBusyItems is the bridge's (source, ids) helper.
const BOARD_METHOD_ARITY = Object.freeze({
  get: 2, set: 4, on: 1, off: 1,
  getPresenceSnapshot: 0, getVoteResultParticipants: 0, onPresenceChange: 1, offPresenceChange: 1,
  setLocalBusyItems: 2, findRemoteBusyItem: 1, getRemoteBusyItems: 0, onBusyChange: 1, offBusyChange: 1,
  getRemoteEditingItems: 0, onEditingChange: 1, offEditingChange: 1,
  setLocalSelectedItems: 1, getRemoteSelectedItems: 0, onSelectionChange: 1, offSelectionChange: 1,
  setLocalCursor: 1, setLocalView: 1,
  uploadImage: 1, listImageSources: 0, rewriteImageSources: 1,
  canCreateItems: 1, consumePublicCreationFailure: 0,
  addItem: 2, addItems: 2, updateItem: 3, updateItems: 2, removeItem: 2, setMeta: 2, replaceBoard: 2,
  importBundle: 4,
  setVote: 3, deleteItemWithVotesAndComments: 1, getRoomHandle: 0, snapshotVotes: 0,
  clearAllVotes: 0, clearVotesFor: 1, clearVotesForItems: 1,
  addComment: 2, editComment: 3, deleteComment: 2, snapshotComments: 0, clearCommentsForItems: 1, clearAllComments: 0,
  finalizeVoteSession: 4, startVoteSession: 4, onVotesChange: 1, offVotesChange: 1,
  snapshotMoods: 0, setMood: 3, clearAllMoods: 0, onMoodsChange: 1, offMoodsChange: 1,
  onCommentsChange: 1, offCommentsChange: 1,
  snapshotTemplates: 0, putTemplate: 1, removeTemplate: 1, onTemplatesChange: 1, offTemplatesChange: 1,
  synced: 0, getSyncStatus: 0, onSyncStatus: 1, getAdminUserId: 0, onSynced: 1,
  stopUndoCapture: 0, undo: 0, redo: 0, canUndo: 0, canRedo: 0, onUndoChange: 1, offUndoChange: 1,
});

function consumedStorageNames() {
  const clientSources = productionSources()
    .filter((file) => file === RETRO_BOARD_SOURCE || file.startsWith(CLIENT_SOURCE_PREFIX))
    .filter((file) => file !== STORAGE_PRODUCER_SOURCE);
  const names = clientSources.flatMap((file) => [
    ...readFileSync(resolve(PROJECT_ROOT, file), 'utf8').matchAll(STORAGE_MEMBER_PATTERN),
  ].map(([, name]) => name));
  return [...new Set(names)].filter((name) => !Object.hasOwn(NOT_STORAGE_MEMBERS, name));
}

const CONSUMED_NAMES = consumedStorageNames();
const BOARD_KEYS = [...new Set([...CONSUMED_NAMES, ...Object.keys(UNCONSUMED_BUT_FROZEN)])]
  .filter((name) => !LOCKED_ONLY_KEYS.includes(name))
  .sort();

const sortedKeys = (object) => Object.keys(object).sort();

test('every storage method the client calls exists on the board route', async () => {
  await withStorage((browser) => {
    const available = new Set([...Object.keys(browser.storage), ...LOCKED_ONLY_KEYS]);
    assert.deepEqual(CONSUMED_NAMES.filter((name) => !available.has(name)), []);
  });
});

test('board route keys equal the frozen contract', async () => {
  await withStorage((browser) => {
    const { storage } = browser;
    assert.deepEqual(sortedKeys(storage), BOARD_KEYS);
    assert.deepEqual(BOARD_KEYS.filter((name) => typeof storage[name] !== 'function'), [...BOARD_OBJECT_MEMBERS].sort());
  });
});

test('the public wall route is the board route without boardReactions and writingTimer', async () => {
  await withStorage((browser) => {
    assert.deepEqual(sortedKeys(browser.storage), BOARD_KEYS.filter((name) => !RETRO_ONLY_KEYS.includes(name)));
  }, { publicWall: true });
});

test('a locked room adds rotationSource and nothing else', async () => {
  await withStorage((browser) => {
    assert.deepEqual(sortedKeys(browser.storage), [...BOARD_KEYS, ...LOCKED_ONLY_KEYS].sort());
  }, { locked: true });
});

test('the landing stub has exactly the frozen no-op keys', async () => {
  await withStorage((browser) => {
    assert.deepEqual(sortedKeys(browser.storage), [...LANDING_KEYS].sort());
  }, { landing: true });
});

test('every landing stub method is inert', async () => {
  await withStorage(async (browser) => {
    const { storage } = browser;
    assert.equal(await storage.get('anything'), null);
    assert.equal(await storage.set('anything', 'value'), undefined);
    for (const [name, expected] of Object.entries(LANDING_STUB_RESULTS)) assert.deepEqual(storage[name](), expected, name);
    for (const name of LANDING_UNSUBSCRIBE_METHODS) {
      const unsubscribe = storage[name](() => assert.fail(`${name} handler must never run`));
      assert.equal(typeof unsubscribe, 'function', name);
      assert.equal(unsubscribe(), undefined, name);
    }
    const answered = new Set(['get', 'set', ...Object.keys(LANDING_STUB_RESULTS), ...LANDING_UNSUBSCRIBE_METHODS]);
    for (const name of LANDING_KEYS.filter((key) => !answered.has(key))) assert.equal(storage[name](), undefined, name);
  }, { landing: true });
});

test('method arity is frozen', async () => {
  await withStorage((browser) => {
    const { storage } = browser;
    const methods = BOARD_KEYS.filter((name) => typeof storage[name] === 'function');
    assert.deepEqual(Object.fromEntries(methods.map((name) => [name, storage[name].length])), BOARD_METHOD_ARITY);
  });
});
