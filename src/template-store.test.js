import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createJsonBackupArtifact } from './board-backup.js';
import { normalizeImportManifest } from './import-schema.js';
import {
  IMPORT_MAX_CUSTOM_TEMPLATES, IMPORT_MAX_TEMPLATE_ZONES, IMPORT_MAX_TOTAL_TEMPLATE_ZONES,
} from './security-boundaries.js';

let store;
beforeEach(async () => { store = await import('./template-store.js'); });
const LEGACY_KEY = 's||customTemplates';
const key = (id) => `s||template:${id}`;
const zone = { title: 'Good', color: 2, x: 0, y: 0, w: 240, h: 200 };
const template = (id, createdAt = 0) => ({ id, name: id, createdAt, zones: [{ ...zone }] });
const docs = (t) => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  t.after(() => { a.destroy(); b.destroy(); });
  return [a, b];
};
const map = (doc) => doc.getMap('kv');
const exchange = (a, b) => {
  const fromA = Y.encodeStateAsUpdate(a);
  const fromB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, fromB);
  Y.applyUpdate(b, fromA);
};
const assertBoth = (a, b, expected) => {
  assert.deepEqual(store.readTemplates(map(a)), expected);
  assert.deepEqual(store.readTemplates(map(b)), expected);
};

test('concurrent saves of different templates both survive', (t) => {
  const [a, b] = docs(t);
  assert.equal(store.putTemplate(a, map(a), template('a')), true);
  assert.equal(store.putTemplate(b, map(b), template('b')), true);
  exchange(a, b);
  assertBoth(a, b, [template('a'), template('b')]);
});

test('concurrent save and delete of different ids preserve both effects', (t) => {
  const [a, b] = docs(t);
  store.putTemplate(a, map(a), template('old'));
  exchange(a, b);
  store.putTemplate(a, map(a), template('new'));
  assert.equal(store.removeTemplate(b, map(b), 'old'), true);
  exchange(a, b);
  assertBoth(a, b, [template('new')]);
});

test('concurrent renames converge on the higher client id; a later rename wins', (t) => {
  const [a, b] = docs(t);
  store.putTemplate(a, map(a), template('same'));
  exchange(a, b);
  const left = { ...template('same'), name: 'Left' };
  const right = { ...template('same'), name: 'Right' };
  store.putTemplate(a, map(a), left);
  store.putTemplate(b, map(b), right);
  const expected = a.clientID > b.clientID ? left : right;
  exchange(a, b);
  assertBoth(a, b, [expected]);
  store.putTemplate(a, map(a), { ...template('same'), name: 'Later' });
  exchange(a, b);
  assertBoth(a, b, [{ ...template('same'), name: 'Later' }]);
});

test('a concurrent set survives deletion of the previously observed value', (t) => {
  const [a, b] = docs(t);
  store.putTemplate(a, map(a), template('same'));
  exchange(a, b);
  const renamed = { ...template('same'), name: 'Renamed' };
  store.putTemplate(a, map(a), renamed);
  store.removeTemplate(b, map(b), 'same');
  exchange(a, b);
  assertBoth(a, b, [renamed]);
  store.removeTemplate(b, map(b), 'same');
  exchange(a, b);
  assertBoth(a, b, []);
});

test('legacy-only migration removes the array, writes keys, and is idempotent', (t) => {
  const [a] = docs(t);
  map(a).set(LEGACY_KEY, [template('a')]);
  store.migrateLegacyTemplates(a, map(a));
  assert.equal(map(a).has(LEGACY_KEY), false);
  assert.deepEqual(map(a).get(key('a')), template('a'));
  const before = Y.encodeStateAsUpdate(a);
  store.migrateLegacyTemplates(a, map(a));
  assert.deepEqual(Y.encodeStateAsUpdate(a), before);
});

test('mixed reads and migration preserve the per-key value over legacy', (t) => {
  const [a] = docs(t);
  map(a).set(LEGACY_KEY, [template('same'), template('legacy')]);
  const newer = { ...template('same'), name: 'Newer' };
  map(a).set(key('same'), newer);
  assert.deepEqual(store.readTemplates(map(a)), [template('legacy'), newer]);
  store.migrateLegacyTemplates(a, map(a));
  assert.deepEqual(store.readTemplates(map(a)), [template('legacy'), newer]);
  assert.equal(map(a).has(LEGACY_KEY), false);
});

test('two clients migrating concurrently converge without duplicates', (t) => {
  const [a, b] = docs(t);
  map(a).set(LEGACY_KEY, [template('a'), template('b')]);
  exchange(a, b);
  store.migrateLegacyTemplates(a, map(a));
  store.migrateLegacyTemplates(b, map(b));
  exchange(a, b);
  assertBoth(a, b, [template('a'), template('b')]);
  assert.equal(map(a).has(LEGACY_KEY), false);
  assert.equal(map(b).has(LEGACY_KEY), false);
});

test('stale legacy rewrites merge on read and re-migrate; deleted ids may reappear', (t) => {
  const [a, b] = docs(t);
  map(a).set(LEGACY_KEY, [template('old')]);
  exchange(a, b);
  store.migrateLegacyTemplates(a, map(a));
  store.removeTemplate(a, map(a), 'old');
  store.putTemplate(a, map(a), template('new'));
  map(b).set(LEGACY_KEY, [template('old'), template('stale')]);
  exchange(a, b);
  const expected = [template('new'), template('old'), template('stale')];
  assertBoth(a, b, expected);
  store.migrateLegacyTemplates(a, map(a));
  exchange(a, b);
  assertBoth(a, b, expected);
  assert.equal(map(b).has(LEGACY_KEY), false);
});

test('put and remove migrate first; undo/redo sync both ways and exclude migration', (t) => {
  const [a, b] = docs(t);
  map(a).set(LEGACY_KEY, [template('legacy')]);
  exchange(a, b);
  const undoA = new Y.UndoManager(map(a), { trackedOrigins: new Set(['local']) });
  const undoB = new Y.UndoManager(map(b), { trackedOrigins: new Set(['local']) });
  t.after(() => { undoA.destroy(); undoB.destroy(); });
  store.putTemplate(a, map(a), template('new'));
  assert.equal(undoA.undoStack.length, 1);
  assert.equal(map(a).has(LEGACY_KEY), false);
  exchange(a, b);
  undoA.undo();
  exchange(a, b);
  assertBoth(a, b, [template('legacy')]);
  undoA.redo();
  exchange(a, b);
  assertBoth(a, b, [template('legacy'), template('new')]);
  store.removeTemplate(b, map(b), 'legacy');
  exchange(a, b);
  assertBoth(a, b, [template('new')]);
  undoB.undo();
  exchange(a, b);
  assertBoth(a, b, [template('legacy'), template('new')]);
  undoB.redo();
  exchange(a, b);
  assertBoth(a, b, [template('new')]);
  map(b).set(LEGACY_KEY, [template('extra')]);
  undoB.stopCapturing();
  store.removeTemplate(b, map(b), 'extra');
  assert.equal(map(b).has(LEGACY_KEY), false);
  undoB.undo();
  assert.deepEqual(store.readTemplates(map(b)), [template('extra'), template('new')]);
});

test('replace inside an import transaction removes all old template keys atomically', (t) => {
  const [a] = docs(t);
  map(a).set(LEGACY_KEY, [template('legacy')]);
  map(a).set(key('old'), template('old'));
  map(a).set(key('corrupt'), null);
  map(a).set('s||unrelated', 'keep');
  const snapshots = [];
  map(a).observe(() => snapshots.push(store.readTemplates(map(a))));
  a.transact(() => store.replaceTemplates(map(a), [template('new')]), 'local');
  assert.deepEqual(snapshots, [[template('new')]]);
  assert.equal(map(a).has(LEGACY_KEY), false);
  assert.equal(map(a).has(key('old')), false);
  assert.equal(map(a).has(key('corrupt')), false);
  assert.equal(map(a).get('s||unrelated'), 'keep');
});

test('reads drop invalid entries, match key ids, and sort deterministically', (t) => {
  const [a] = docs(t);
  map(a).set(LEGACY_KEY, [null, template('b'), { ...template('bad'), name: '' }]);
  map(a).set(key('a'), template('a'));
  map(a).set(key('mismatch'), template('different'));
  const missingTime = { ...template('missing'), createdAt: undefined };
  map(a).set(key('missing'), missingTime);
  map(a).set(key('early'), template('early', 1));
  assert.deepEqual(store.readTemplates(map(a)), [
    template('a'), template('b'), template('missing'), template('early', 1),
  ]);
  assert.equal(store.putTemplate(a, map(a), { ...template('bad'), zones: [] }), false);
  assert.equal(store.removeTemplate(a, map(a), 'bad:id'), false);
});

test('template count cap rejects writes and bounds reads deterministically', (t) => {
  const [a, b] = docs(t);
  const entries = Array.from({ length: IMPORT_MAX_CUSTOM_TEMPLATES }, (_, index) => template(`t${index}`, index));
  a.transact(() => store.replaceTemplates(map(a), entries), 'local');
  assert.equal(store.putTemplate(a, map(a), template('overflow')), false);
  assert.equal(store.putTemplate(a, map(a), { ...entries[0], name: 'Rename' }), true);
  map(a).set(key('overflow'), template('overflow', IMPORT_MAX_CUSTOM_TEMPLATES));
  exchange(a, b);
  assert.equal(store.readTemplates(map(a)).length, IMPORT_MAX_CUSTOM_TEMPLATES);
  assert.deepEqual(store.readTemplates(map(a)), store.readTemplates(map(b)));
  assert.equal(store.putTemplate(a, map(a), template('another')), false);
});

test('total zone cap rejects puts without mutation and deterministically bounds reads', (t) => {
  const [a, b] = docs(t);
  const full = Array.from({ length: IMPORT_MAX_TOTAL_TEMPLATE_ZONES / IMPORT_MAX_TEMPLATE_ZONES }, (_, index) => ({
    ...template(`t${index}`, index), zones: Array.from({ length: IMPORT_MAX_TEMPLATE_ZONES }, () => ({ ...zone })),
  }));
  a.transact(() => store.replaceTemplates(map(a), full), 'local');
  const before = Y.encodeStateAsUpdate(a);
  assert.equal(store.putTemplate(a, map(a), template('overflow')), false);
  assert.deepEqual(Y.encodeStateAsUpdate(a), before);
  map(a).set(key('overflow'), template('overflow', IMPORT_MAX_TOTAL_TEMPLATE_ZONES));
  exchange(a, b);
  assertBoth(a, b, full);
});

test('template snapshots export and import exactly through the backup decoder', (t) => {
  const [a, b] = docs(t);
  store.putTemplate(a, map(a), template('a'));
  store.putTemplate(a, map(a), template('b', 1));
  const original = store.readTemplates(map(a));
  const artifact = createJsonBackupArtifact({
    pathname: '/b/Room123', board: { items: [] }, exportedAt: 0, customTemplates: original,
  });
  const decoded = normalizeImportManifest(JSON.parse(artifact.contents), 0);
  b.transact(() => store.replaceTemplates(map(b), decoded.customTemplates), 'local');
  assert.deepEqual(decoded.customTemplates, original);
  assertBoth(a, b, original);
});
