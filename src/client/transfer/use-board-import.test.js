import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportBundleLimitError } from './board-transfer.js';
import { createController } from './use-board-import.js';

function harness(overrides = {}) {
  const calls = [];
  const manifest = { voteEntries: ['v'], commentEntries: ['c'], moodEntries: ['m'], customTemplates: ['t'] };
  const board = { items: [{ id: 'restored' }] };
  const storage = { importBundle(...args) { assert.equal(this, storage); calls.push(['commit', ...args]); return true; } };
  const options = {
    isAdmin: true, fileInputRef: { current: { click: () => calls.push(['pick']) } },
    setToast: value => calls.push(['toast', value]), setPendingImport: value => calls.push(['pending', value]),
    pendingImport: manifest, importBusy: false, setImportBusy: value => calls.push(['busy', value]),
    boardRef: { current: { title: 'live' } }, setBoard: value => calls.push(['board', value]),
    readBoardImport: async () => manifest, prepareBoardImport: async () => board,
    ImportBundleLimitError, t: (key, args) => ({ key, ...args }), window: { storage }, ...overrides,
  };
  return { controller: createController(options), options, calls, manifest, board };
}

test('import commits one complete bundle before replacing local board (INV-13)', async () => {
  const h = harness();
  await h.controller.confirmImport();
  assert.deepEqual(h.calls, [
    ['busy', true], ['commit', h.board, ['v'], ['c'], ['t'], ['m']], ['board', h.board],
    ['pending', null], ['busy', false], ['toast', { msg: { key: 'import.done', n: 1 }, type: 'info' }],
  ]);
  h.controller.onImportPick();
  assert.deepEqual(h.calls.at(-1), ['pick']);
  h.controller.dispose();
});

test('file read failure resets the picker and reports failure without committing', async () => {
  const h = harness({ readBoardImport: async () => { throw new Error('bad file'); } });
  const event = { target: { files: [{}], value: 'backup' } };
  await h.controller.onImportFileChange(event);
  assert.equal(event.target.value, '');
  assert.deepEqual(h.calls, [['toast', { msg: { key: 'import.fail', err: 'bad file' }, type: 'warn' }]]);
});

test('preparation rejection clears busy and preserves pending/local state', async () => {
  for (const error of [new Error('bad image'), new ImportBundleLimitError(12)]) {
    const h = harness({ prepareBoardImport: async () => { throw error; } });
    await h.controller.confirmImport();
    assert.deepEqual(h.calls.slice(0, 2), [['busy', true], ['busy', false]]);
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2][1].type, 'warn');
    assert.equal(h.calls[2][1].msg.key, error instanceof ImportBundleLimitError ? 'import.tooLarge' : 'import.fail');
  }
});

test('bridge rejection clears busy without replacing the local board or dismissing confirmation', async () => {
  const h = harness({ window: { storage: { importBundle: () => false } } });
  await h.controller.confirmImport();
  assert.deepEqual(h.calls, [['busy', true], ['busy', false], ['toast', {
    msg: { key: 'import.fail', err: 'invalid import bundle' }, type: 'warn',
  }]]);
});

test('missing manifest, non-admin and busy confirmations are inert; empty file is inert', async () => {
  for (const overrides of [{ pendingImport: null }, { isAdmin: false }, { importBusy: true }]) {
    const h = harness(overrides);
    await h.controller.confirmImport();
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  await h.controller.onImportFileChange({ target: { files: [], value: 'old' } });
  assert.deepEqual(h.calls, []);
});
