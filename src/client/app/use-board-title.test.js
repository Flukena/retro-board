import test from 'node:test';
import assert from 'node:assert/strict';
import { documentTitleFor, seedBoardTitle } from './use-board-title.js';
import { t } from '../ui/i18n.js';

const fakeStorage = (boardState) => ({ get: async () => (boardState ? { value: boardState } : null) });

test('seeding writes the creator title silently only into a never-named room', async () => {
  const writes = [];
  const patchMeta = (patch, opts) => writes.push([patch, opts]);
  assert.equal(await seedBoardTitle({ storage: fakeStorage({ items: [] }), pendingTitle: ' Sprint 42 ', patchMeta }), 'Sprint 42');
  assert.deepEqual(writes, [[{ title: 'Sprint 42' }, { silent: true }]]);
  assert.equal(await seedBoardTitle({ storage: fakeStorage({ items: [], title: 'Kept' }), pendingTitle: 'New', patchMeta }), null);
  assert.equal(await seedBoardTitle({ storage: fakeStorage({ items: [] }), pendingTitle: '', patchMeta }), null);
  assert.equal(writes.length, 1);
});

test('document title names the board before the app', () => {
  assert.equal(documentTitleFor('Sprint 42'), `Sprint 42 · ${t('app.title')}`);
  assert.equal(documentTitleFor(null), t('app.title'));
});
