import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonBackupArtifact } from './board-backup.js';
import { createBoardArchiveArtifact, readBoardArchive } from './board-archive.js';
import { normalizeImportManifest } from './import-schema.js';
import { decodeRemoteItem } from './remote-board-decoder.js';
import { buildVoteResults } from './vote-results.js';
import { templateZonesFromSelection } from './template-model.js';
import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/index-native.js';

const zone = { id: 'zone', type: 'zone', title: 'Votes', x: 0, y: 0, w: 800, h: 600 };
const result = buildVoteResults({ ...zone, voteTimer: { startedAt: 10, endsAt: null, showNonVoters: true } }, [], new Map(), [{ userId: 'u', name: 'Example' }], 100);
const board = { items: [{ ...zone, voteResults: result }] };

test('remote decoder keeps valid snapshot and drops only malformed result, retaining zone', () => {
  assert.equal(decodeRemoteItem(board.items[0]).voteResults, result);
  for (const invalid of [{}, [], { ...result, participants: 'bad' }, { ...result, finalizedAt: -1 }]) {
    const decoded = decodeRemoteItem({ ...zone, voteResults: invalid });
    assert.equal(decoded.id, zone.id);
    assert.equal(Object.hasOwn(decoded, 'voteResults'), false);
  }
});
test('JSON and template export strip results and JSON import cannot reintroduce them', () => {
  const artifact = createJsonBackupArtifact({ board, exportedAt: 100 });
  assert.doesNotMatch(artifact.contents, /voteResults|Example/);
  const payload = JSON.parse(artifact.contents);
  payload.board.items[0].voteResults = result;
  assert.equal(Object.hasOwn(normalizeImportManifest(payload, 100).items[0], 'voteResults'), false);
  assert.equal(Object.hasOwn(templateZonesFromSelection(board.items, ['zone'])[0], 'voteResults'), false);
});
test('ZIP manifest strips results and a hostile ZIP import cannot reintroduce them', async () => {
  const artifact = await createBoardArchiveArtifact({ board, exportedAt: 100 }, () => assert.fail('no images'));
  const reader = new ZipReader(new BlobReader(artifact.blob), { useWebWorkers: false });
  let payload;
  try {
    const entries = await reader.getEntries();
    const contents = await entries.find((entry) => entry.filename === 'board.json').getData(new TextWriter());
    assert.doesNotMatch(contents, /voteResults|Example/);
    payload = JSON.parse(contents);
  } finally { await reader.close(); }
  payload.board.items[0].voteResults = result;
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level: 0 });
  await writer.add('board.json', new TextReader(JSON.stringify(payload)));
  const decoded = await readBoardArchive(await writer.close(), 100);
  assert.equal(Object.hasOwn(decoded.items[0], 'voteResults'), false);
});
