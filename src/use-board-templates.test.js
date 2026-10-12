import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { putTemplate, readTemplates, removeTemplate, isTemplateKey } from './template-store.js';
import { setLang, t as translate } from './i18n.js';

let templates;
beforeEach(async () => { templates = await import('./use-board-templates.js'); });

const fixture = (t) => {
  const doc = new Y.Doc();
  const map = doc.getMap('kv');
  const events = new EventTarget();
  const sync = new EventTarget();
  t.after(() => doc.destroy());
  map.observe((event) => {
    if ([...event.keysChanged].some(isTemplateKey)) events.dispatchEvent(new Event('change'));
  });
  const storage = {
    snapshotTemplates: () => readTemplates(map),
    putTemplate: (entry) => putTemplate(doc, map, entry),
    removeTemplate: (id) => removeTemplate(doc, map, id),
    onTemplatesChange: (handler) => events.addEventListener('change', handler),
    offTemplatesChange: (handler) => events.removeEventListener('change', handler),
    onSynced(handler) {
      sync.addEventListener('sync', handler);
      return () => sync.removeEventListener('sync', handler);
    },
  };
  const toast = [];
  let closed = false;
  const boardRef = { current: { items: [
    { type: 'zone', title: 'A', color: 2, x: 100, y: 200, w: 240, h: 200 },
    { type: 'sticky', x: 0, y: 0 },
    { type: 'zone', title: 'B', color: 1, x: 400, y: 500, w: 240, h: 200 },
  ] } };
  const actions = templates.createTemplateActions({
    storage, boardRef, createId: () => 'saved',
    setToast: (value) => toast.push(value), closeSaveDialog: () => { closed = true; },
  });
  return { doc, map, storage, sync, toast, actions, boardRef, isClosed: () => closed };
};

test('subscription catches initial state, local/remote changes, resync, and cleans up', (t) => {
  const f = fixture(t);
  const snapshots = [];
  const off = templates.subscribeTemplates(f.storage, (value) => snapshots.push(value));
  assert.deepEqual(snapshots, [[]]);
  f.actions.saveCurrentAsTemplate('Saved');
  assert.equal(snapshots.at(-1)[0].name, 'Saved');
  const peer = new Y.Doc();
  t.after(() => peer.destroy());
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(f.doc));
  removeTemplate(peer, peer.getMap('kv'), 'saved');
  Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(peer));
  assert.deepEqual(snapshots.at(-1), []);
  const beforeSync = snapshots.length;
  f.sync.dispatchEvent(new Event('sync'));
  assert.equal(snapshots.length, beforeSync + 1);
  off();
  f.actions.saveCurrentAsTemplate('After cleanup');
  f.sync.dispatchEvent(new Event('sync'));
  assert.equal(snapshots.length, beforeSync + 1);
});

test('saving current zones keeps existing relative geometry and deletes through the store', (t) => {
  const f = fixture(t);
  f.actions.saveCurrentAsTemplate('  Saved  ');
  const [saved] = readTemplates(f.map);
  assert.equal(saved.name, 'Saved');
  assert.deepEqual(saved.zones, [
    { title: 'A', color: 2, x: 0, y: 0, w: 240, h: 200 },
    { title: 'B', color: 1, x: 300, y: 300, w: 240, h: 200 },
  ]);
  assert.equal(f.isClosed(), true);
  assert.equal(f.toast.at(-1).type, 'info');
  f.actions.deleteCustomTemplate('saved');
  assert.deepEqual(readTemplates(f.map), []);
});

test('blank and empty saves keep the dialog; rejected save/delete warnings use th and en', (t) => {
  const f = fixture(t);
  f.actions.saveCurrentAsTemplate('  ');
  assert.deepEqual(f.toast, []);
  assert.equal(f.isClosed(), false);
  f.boardRef.current.items = [];
  f.actions.saveCurrentAsTemplate('Empty');
  assert.equal(f.toast.at(-1).msg, translate('tmpl.empty'));
  f.boardRef.current.items = [{ type: 'zone', x: 0, y: 0, w: -1, h: 200 }];
  for (const lang of ['th', 'en']) {
    setLang(lang);
    f.actions.saveCurrentAsTemplate('Invalid');
    assert.equal(f.toast.at(-1).msg, translate('tmpl.saveFailed'));
    assert.notEqual(f.toast.at(-1).msg, 'tmpl.saveFailed');
    assert.equal(f.toast.at(-1).type, 'warn');
    f.actions.deleteCustomTemplate('missing');
    assert.equal(f.toast.at(-1).msg, translate('tmpl.saveFailed'));
  }
  assert.equal(f.isClosed(), false);
  assert.deepEqual(readTemplates(f.map), []);
});
