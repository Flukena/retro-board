import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBoardExport, readBoardImport, prepareBoardImport, ImportBundleLimitError } from './board-transfer.js';
import { IMPORT_MAX_FILE_BYTES } from '../../domain/import-schema.js';
import { BOARD_TEXT_MAX_LENGTH } from '../../domain/security-boundaries.js';

const IMPORTED_AT_MS = 1_700_000_000_000;
const OVER_LIMIT_ITEM_COUNT = 64;
const zone = { id: 'zone', type: 'zone', x: 0, y: 0, w: 500, h: 400, title: 'Ideas',
  voteTimer: { endsAt: IMPORTED_AT_MS }, lastResultsAt: IMPORTED_AT_MS, voteResults: {}, votingLocked: true };
const payload = { board: { items: [zone], editingLocked: true, title: 'Imported retro' } };
const file = () => new File([JSON.stringify(payload)], 'board.json', { type: 'application/json' });

test('file intake validates JSON and exposes one normalized manifest for confirmation', async () => {
  const manifest = await readBoardImport(file(), IMPORTED_AT_MS);
  assert.equal(manifest.name, 'board.json');
  assert.equal(manifest.sourceFormat, 'json');
  assert.equal(manifest.items[0].id, 'zone');
  assert.equal(manifest.boardMeta.editingLocked, true);
  assert.deepEqual(manifest.voteEntries, []);
});

test('import preparation clears zone sessions while preserving the current room identity', async () => {
  const manifest = await readBoardImport(file(), IMPORTED_AT_MS);
  const pinHash = createHash('sha256').update('room-identity-fixture').digest('hex');
  const identity = { adminUserId: 'current-owner', adminName: 'Current owner', adminPinHash: pinHash };
  const board = await prepareBoardImport(manifest, identity);
  assert.equal(board.adminUserId, identity.adminUserId);
  assert.equal(board.adminName, identity.adminName);
  assert.equal(board.adminPinHash, pinHash);
  assert.equal(board.editingLocked, true);
  assert.equal(board.title, 'Imported retro');
  assert.equal(board.items[0].voteTimer, null);
  assert.equal(board.items[0].voteResults, null);
  assert.equal(board.items[0].votingLocked, false);
});

test('oversized file intake fails before reading and oversized room updates fail before commit', async () => {
  const tooBig = { name: 'large.json', type: 'application/json', size: IMPORT_MAX_FILE_BYTES + 1,
    text() { assert.fail('Oversized input must not be read'); } };
  await assert.rejects(readBoardImport(tooBig), /file exceeds/);
  const manifest = await readBoardImport(file(), IMPORTED_AT_MS);
  manifest.items = Array.from({ length: OVER_LIMIT_ITEM_COUNT }, (_, index) => ({
    id: `sticky-${index}`, type: 'sticky', x: index, y: 0, text: 'a'.repeat(BOARD_TEXT_MAX_LENGTH),
  }));
  await assert.rejects(prepareBoardImport(manifest, {}), ImportBundleLimitError);
});

test('importing a backup without a title keeps the current room title', async () => {
  const untitled = new File([JSON.stringify({ board: { items: [zone] } })], 'old.json', { type: 'application/json' });
  const manifest = await readBoardImport(untitled, IMPORTED_AT_MS);
  assert.equal((await prepareBoardImport(manifest, { title: 'Current room' })).title, 'Current room');
  assert.equal((await prepareBoardImport(manifest, {})).title, null);
});

test('import ends any live presenter session and meeting phase instead of carrying them over', async () => {
  const manifest = await readBoardImport(file(), IMPORTED_AT_MS);
  const board = await prepareBoardImport(manifest, { adminUserId: 'owner', presenterUserId: 'owner', phase: { id: 'vote', startedAt: 1 } });
  assert.equal(board.presenterUserId, null);
  assert.equal(board.phase, null);
});

test('import keeps the backed-up mood round, closed, and its answers', async () => {
  const moodCheck = { id: 'round1', startedAt: IMPORTED_AT_MS, open: true };
  const withMoods = new File([JSON.stringify({ ...payload, board: { ...payload.board, moodCheck }, moods: { 'user-a': 3 } })],
    'board.json', { type: 'application/json' });
  const manifest = await readBoardImport(withMoods, IMPORTED_AT_MS);
  const board = await prepareBoardImport(manifest, { moodCheck: { id: 'current', startedAt: 1, open: true } });
  assert.deepEqual(board.moodCheck, { ...moodCheck, open: false });
  assert.deepEqual(manifest.moodEntries, [{ roundId: 'round1', userId: 'user-a', score: 3 }]);
  const plain = await prepareBoardImport(await readBoardImport(file(), IMPORTED_AT_MS), { moodCheck });
  assert.equal(plain.moodCheck, null);
});

test('a shown mood round exports and re-imports closed with its result hidden', async (context) => {
  const previousWindow = globalThis.window;
  globalThis.window = { storage: {}, location: { pathname: '/ROOM1', origin: 'http://localhost' } };
  context.after(() => { globalThis.window = previousWindow; });
  const moodCheck = { id: 'round1', startedAt: IMPORTED_AT_MS, open: false, resultShownAt: IMPORTED_AT_MS + 1 };
  const artifact = await createBoardExport({ items: [zone], moodCheck }, { boardCode: 'ROOM1', userId: 'user-a' });
  const manifest = await readBoardImport(new File([artifact.blob], artifact.fileName, { type: artifact.mimeType }), IMPORTED_AT_MS);
  const board = await prepareBoardImport(manifest, {});
  assert.equal(board.moodCheck.open, false);
  assert.equal(board.moodCheck.id, 'round1');
  assert.equal('resultShownAt' in board.moodCheck, false);
});

test('a backup preserves a readable sticky editor and redacts the editor of a hidden sticky', async (context) => {
  const previousWindow = globalThis.window;
  globalThis.window = { storage: {}, location: { pathname: '/ROOM1', origin: 'http://localhost' } };
  context.after(() => { globalThis.window = previousWindow; });
  const sticky = { id: 'idea', type: 'sticky', x: 40, y: 50, text: 'Original content',
    authorId: 'owner', authorName: 'Ada', private: true, lastEditor: { userId: 'peer', name: 'Bo' } };
  for (const userId of ['owner', 'viewer']) {
    const artifact = await createBoardExport({ items: [sticky] }, { boardCode: 'ROOM1', userId });
    const manifest = await readBoardImport(new File([artifact.blob], artifact.fileName, { type: artifact.mimeType }), IMPORTED_AT_MS);
    const [restored] = (await prepareBoardImport(manifest, {})).items;
    assert.equal(restored.authorName, sticky.authorName);
    assert.equal(restored.text, userId === 'owner' ? sticky.text : '');
    assert.deepEqual(restored.lastEditor, userId === 'owner' ? sticky.lastEditor : undefined);
  }
});
