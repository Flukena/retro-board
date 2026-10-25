import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { putTemplate, readTemplates, removeTemplate, isTemplateKey } from '../../domain/template-store.js';
import { TEMPLATE_NAME_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { setLang, t as translate } from '../ui/i18n.js';

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
  let menuClosed = false;
  const renameRef = { current: null };
  const boardRef = { current: { items: [
    { id: 'a', type: 'zone', title: 'A', color: 2, x: 100, y: 200, w: 240, h: 200 },
    { type: 'sticky', x: 0, y: 0 },
    { id: 'b', type: 'zone', title: 'B', color: 1, x: 400, y: 500, w: 240, h: 200 },
  ] } };
  const actions = templates.createTemplateActions({
    storage, createId: () => 'saved', renameRef,
    onRenameTargetChange: (value) => { renameRef.current = value; }, closeTemplates: () => { menuClosed = true; },
    setToast: (value) => toast.push(value), setSaveTemplateOpen: (open) => { closed = !open; },
  });
  return { doc, map, storage, sync, toast, actions, boardRef, renameRef, isMenuClosed: () => menuClosed, isClosed: () => closed };
};

test('subscription catches initial state, local/remote changes, resync, and cleans up', (t) => {
  const f = fixture(t);
  const snapshots = [];
  const off = templates.subscribeTemplates(f.storage, (value) => snapshots.push(value));
  assert.deepEqual(snapshots, [[]]);
  f.actions.openSaveTemplate(f.boardRef.current.items, ['a']);
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
  f.actions.openSaveTemplate(f.boardRef.current.items, ['a']);
  f.actions.saveCurrentAsTemplate('After cleanup');
  f.sync.dispatchEvent(new Event('sync'));
  assert.equal(snapshots.length, beforeSync + 1);
});

test('saving current zones keeps existing relative geometry and deletes through the store', (t) => {
  const f = fixture(t);
  f.actions.openSaveTemplate(f.boardRef.current.items, ['a', 'b']);
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

test('blank saves are inert, empty selection stays closed, and rejected saves stay open in th/en', (t) => {
  const f = fixture(t);
  f.actions.saveCurrentAsTemplate('  ');
  assert.deepEqual(f.toast, []);
  assert.equal(f.isClosed(), false);
  f.boardRef.current.items = [];
  f.actions.openSaveTemplate([], []);
  assert.equal(f.toast.at(-1).msg, translate('tmpl.selectZones'));
  assert.equal(f.isClosed(), true);
  f.boardRef.current.items = [{ id: 'invalid', type: 'zone', x: 0, y: 0, w: -1, h: 200 }];
  for (const lang of ['th', 'en']) {
    setLang(lang);
    f.actions.openSaveTemplate(f.boardRef.current.items, ['invalid']);
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


test('draft copies selected values once, survives moves/deletes, and clears on success or cancel', (t) => {
  const f = fixture(t);
  const ids = new Set(['a']);
  f.actions.openSaveTemplate(f.boardRef.current.items, ids);
  ids.clear();
  f.boardRef.current.items[0].x = 900;
  f.boardRef.current.items[0].title = 'Changed remotely';
  f.boardRef.current.items = [];
  f.actions.saveCurrentAsTemplate('Snapshot');
  const [saved] = readTemplates(f.map);
  assert.equal(saved.zones.length, 1);
  assert.equal(saved.zones[0].title, 'A');
  assert.equal(saved.zones[0].x, 0);
  f.actions.saveCurrentAsTemplate('Cleared');
  assert.equal(readTemplates(f.map)[0].name, 'Snapshot');
  f.actions.openSaveTemplate([{ id: 'c', type: 'zone', title: 'C', color: 1, x: 0, y: 0, w: 200, h: 200 }], ['c']);
  f.actions.closeSaveDialog();
  f.actions.saveCurrentAsTemplate('Cancelled');
  assert.equal(readTemplates(f.map)[0].name, 'Snapshot');
});

test('apply places zones with current author and rederived owners; write/placement failures stay open', () => {
  const toasts = [];
  const added = [];
  let closed = 0;
  let accepts = true;
  const zones = [{ title: 'Parent', color: 2, x: 0, y: 0, w: 500, h: 500 }, { title: 'Child', color: 1, x: 100, y: 100, w: 100, h: 100 }];
  let id = 0;
  const actions = templates.createTemplateActions({
    storage: { snapshotTemplates: () => [{ id: 'custom', name: 'Custom', zones }] },
    createId: () => `placed-${++id}`, userId: 'author', userName: 'Ada',
    setToast: (value) => toasts.push(value), closeTemplates: () => { closed += 1; },
    addItemsLocal: (items) => { added.push(items); return accepts; },
  });
  const bounds = actions.applyTemplate('custom', { viewportCenter: { x: 0, y: 0 }, items: [{ type: 'text', x: -250, y: -250 }] });
  assert.ok(bounds);
  assert.notEqual(bounds.x, -250);
  assert.equal(added[0][0].parentZoneId, null);
  assert.equal(added[0][1].parentZoneId, added[0][0].id);
  assert.equal(added[0][1].authorId, 'author');
  assert.equal(added[0][1].authorName, 'Ada');
  assert.equal(closed, 1);
  accepts = false;
  assert.equal(actions.applyTemplate('custom', { viewportCenter: { x: 0, y: 0 }, items: [] }), null);
  assert.equal(closed, 1);
  const writes = added.length;
  for (const lang of ['th', 'en']) {
    setLang(lang);
    assert.equal(actions.applyTemplate('custom', { viewportCenter: { x: 1e20, y: 1e20 }, items: [] }), null);
    assert.equal(toasts.at(-1).msg, translate('tmpl.placementFailed'));
  }
  assert.equal(added.length, writes);
  assert.equal(closed, 1);
});


test('failed store writes retain draft and count for retry, including action recreation', () => {
  const draftRef = { current: [] };
  const counts = [];
  const saved = [];
  let accepts = false;
  let opened = false;
  const config = {
    draftRef, storage: { putTemplate: (entry) => { if (accepts) saved.push(entry); return accepts; } },
    onDraftChange: (zones) => counts.push(zones.length),
    setSaveTemplateOpen: (open) => { opened = open; }, setToast: () => {}, createId: () => 'retry',
  };
  const actions = templates.createTemplateActions(config);
  actions.openSaveTemplate([{ id: 'a', type: 'zone', title: 'A', color: 2, x: 10, y: 20, w: 200, h: 200 }], ['a']);
  actions.saveCurrentAsTemplate('First');
  assert.equal(opened, true);
  assert.deepEqual(counts, [1]);
  accepts = true;
  templates.createTemplateActions(config).saveCurrentAsTemplate('Retry');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].zones.length, 1);
  assert.equal(saved[0].zones[0].title, 'A');
  assert.equal(opened, false);
  assert.deepEqual(counts, [1, 0]);
});


const saveRenameFixture = (f) => {
  f.actions.openSaveTemplate(f.boardRef.current.items, ['a']);
  f.actions.saveCurrentAsTemplate('Original');
};

test('rename uses latest zones/timestamp, trims/caps name, closes menu and dialog, and undo restores old name', (t) => {
  const f = fixture(t);
  saveRenameFixture(f);
  const undo = new Y.UndoManager(f.map, { trackedOrigins: new Set(['local']) });
  t.after(() => undo.destroy());
  f.actions.openRenameTemplate('saved');
  assert.deepEqual(f.renameRef.current, { id: 'saved', name: 'Original' });
  assert.equal(f.isMenuClosed(), true);
  const latest = { ...f.storage.snapshotTemplates()[0], zones: [{ title: 'Remote', color: 1, x: 0, y: 0, w: 300, h: 200 }], createdAt: 123 };
  f.doc.transact(() => f.map.set('s||template:saved', latest), 'remote');
  f.actions.renameCustomTemplate('  ' + 'N'.repeat(TEMPLATE_NAME_MAX_LENGTH + 1) + '  ');
  assert.deepEqual(f.storage.snapshotTemplates()[0], { ...latest, name: 'N'.repeat(TEMPLATE_NAME_MAX_LENGTH) });
  assert.equal(f.renameRef.current, null);
  assert.equal(f.toast.at(-1).msg, translate('tmpl.renamed', { name: 'N'.repeat(TEMPLATE_NAME_MAX_LENGTH) }));
  undo.undo();
  assert.equal(f.storage.snapshotTemplates()[0].name, 'Original');
});

test('remote delete before rename submit warns in th/en, closes and never resurrects', (t) => {
  const f = fixture(t);
  for (const lang of ['th', 'en']) {
    setLang(lang);
    saveRenameFixture(f);
    f.actions.openRenameTemplate('saved');
    const peer = new Y.Doc();
    t.after(() => peer.destroy());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(f.doc));
    removeTemplate(peer, peer.getMap('kv'), 'saved');
    Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(peer));
    f.actions.renameCustomTemplate('New');
    assert.deepEqual(f.storage.snapshotTemplates(), []);
    assert.equal(f.renameRef.current, null);
    assert.equal(f.toast.at(-1).type, 'warn');
    assert.equal(f.toast.at(-1).msg, translate('tmpl.renameMissing'));
    assert.notEqual(translate('tmpl.renameMissing'), 'tmpl.renameMissing');
    f.actions.openRenameTemplate('missing');
    assert.equal(f.renameRef.current, null);
    assert.equal(f.toast.at(-1).msg, translate('tmpl.renameMissing'));
  }
});

test('rename blanks are rejected; failure retains target for retry; close and switching reset target', (t) => {
  const f = fixture(t);
  saveRenameFixture(f);
  f.actions.openRenameTemplate('saved');
  const originalToastCount = f.toast.length;
  f.actions.renameCustomTemplate('  ');
  assert.equal(f.storage.snapshotTemplates()[0].name, 'Original');
  assert.equal(f.toast.length, originalToastCount);
  const write = f.storage.putTemplate;
  f.storage.putTemplate = () => false;
  f.actions.renameCustomTemplate('Retry');
  assert.equal(f.renameRef.current.id, 'saved');
  assert.equal(f.toast.at(-1).msg, translate('tmpl.saveFailed'));
  f.storage.putTemplate = write;
  f.actions.renameCustomTemplate('Retry');
  assert.equal(f.renameRef.current, null);
  f.storage.putTemplate({ ...f.storage.snapshotTemplates()[0], id: 'other', name: 'Other' });
  f.actions.openRenameTemplate('saved');
  f.actions.openRenameTemplate('other');
  assert.deepEqual(f.renameRef.current, { id: 'other', name: 'Other' });
  f.actions.closeRenameDialog();
  assert.equal(f.renameRef.current, null);
});
