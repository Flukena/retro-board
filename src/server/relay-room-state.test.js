import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ROOM_BLOCK_TTL_MS } from './relay-config.js';
import { persistenceFixture, deferred, DOC_NAME } from '../test-support/relay-persistence-fixture.js';

const Y = createRequire(import.meta.url)('yjs');
const persistedDoc = () => {
  const doc = new Y.Doc();
  doc.getMap('data').set('on-disk', true);
  return doc;
};

test('room update listener stores edits before hydration resolves and never echoes the disk update', async t => {
  const loaded = deferred();
  const fixture = await persistenceFixture(t, { hydrate: () => loaded.promise, bind: false });
  const ready = fixture.state.runtimePersistence.bindState(DOC_NAME, fixture.doc);
  fixture.doc.getMap('data').set('during-read', true);
  assert.equal(fixture.stores.length, 1, 'listener must attach before first await');
  const stored = persistedDoc();
  loaded.resolve(stored);
  await ready;
  assert.equal(stored.isDestroyed, true);
  assert.equal(fixture.doc.getMap('data').get('on-disk'), true);
  assert.equal(fixture.doc.getMap('data').get('during-read'), true);
  assert.equal(fixture.stores.length, 1, 'hydration origin must not be persisted again');
});

test('a room destroyed during hydration releases the persisted temporary doc without applying it', async t => {
  const loaded = deferred();
  const fixture = await persistenceFixture(t, { hydrate: () => loaded.promise, bind: false });
  const ready = fixture.state.runtimePersistence.bindState(DOC_NAME, fixture.doc);
  fixture.doc.destroy();
  const stored = persistedDoc();
  loaded.resolve(stored);
  await ready;
  assert.equal(stored.isDestroyed, true);
  assert.equal(fixture.doc.getMap('data').has('on-disk'), false);
  assert.equal(fixture.stores.length, 0);
});

test('floating bindState contains hydration failure and requests a fatal drain', async t => {
  t.mock.method(console, 'error', () => {});
  const fixture = await persistenceFixture(t, { hydrate: async () => { throw new Error('fake read failure'); }, bind: false });
  await assert.doesNotReject(fixture.state.runtimePersistence.bindState(DOC_NAME, fixture.doc));
  assert.deepEqual(fixture.state.shutdowns, [['storage failure', true]]);
});

test('resource policy closes existing peers and expires a blocked room at the configured TTL', async t => {
  const fixture = await persistenceFixture(t, { limits: { MAX_UPDATE_BYTES: 1 } });
  const closes = [];
  fixture.doc.conns.set({ close: (...args) => closes.push(args) }, new Set());
  fixture.doc.getMap('data').set('over-limit', true);
  assert.deepEqual(closes, [[1009, 'room resource limit']]);
  const blocked = fixture.state.maintenance.blockedRooms;
  assert.equal(blocked.has(DOC_NAME), true);
  fixture.advance(ROOM_BLOCK_TTL_MS);
  fixture.state.maintenance.votes.finalize(DOC_NAME, fixture.doc);
  assert.equal(blocked.has(DOC_NAME), false);
});
