import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readBoardImport, prepareBoardImport, ImportBundleLimitError } from './board-transfer.js';
import { IMPORT_MAX_FILE_BYTES } from '../../domain/import-schema.js';
import { BOARD_TEXT_MAX_LENGTH } from '../../domain/security-boundaries.js';

const IMPORTED_AT_MS = 1_700_000_000_000;
const OVER_LIMIT_ITEM_COUNT = 64;
const zone = { id: 'zone', type: 'zone', x: 0, y: 0, w: 500, h: 400, title: 'Ideas',
  voteTimer: { endsAt: IMPORTED_AT_MS }, lastResultsAt: IMPORTED_AT_MS, voteResults: {}, votingLocked: true };
const payload = { board: { items: [zone], editingLocked: true } };
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
