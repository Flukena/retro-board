import test from 'node:test';
import assert from 'node:assert/strict';

import { createCsvExportArtifact, createJsonBackupArtifact } from './board-backup.js';
import { normalizeImportManifest } from './import-schema.js';

test('JSON backup is immediately re-importable even when trusted room geometry is corrupt', () => {
  const artifact = createJsonBackupArtifact({
    fallbackBoardCode: 'Wrong123',
    pathname: '/b/Right456',
    exportedAt: 1_700_000_000_000,
    board: {
      items: [
        { id: 'sticky-1', type: 'sticky', x: null, y: null, w: 200, h: 180, text: 'Hello' },
      ],
      editingLocked: false,
      votingLocked: false,
      allRevealed: false,
      lastResultsAt: null,
    },
    votes: { 'sticky-1': ['user-1'] },
    comments: {},
    customTemplates: [],
  });

  const payload = JSON.parse(artifact.contents);
  const decoded = normalizeImportManifest(payload, payload.exportedAt);

  assert.equal(artifact.fileName, 'retro-Right456-2023-11-14-22-13-20.json');
  assert.deepEqual(artifact.geometryRepairs, { positions: 1, zoneDimensions: 0 });
  assert.equal(payload.boardCode, 'Right456');
  assert.deepEqual(decoded.geometryRepairs, { positions: 0, zoneDimensions: 0 });
  assert.equal(decoded.items.length, 1);
  assert.equal(decoded.voteEntries.length, 1);
});

test('CSV artifact always names the current room and optional zone', () => {
  const room = createCsvExportArtifact({
    csv: '\ufeffZone,Text',
    fallbackBoardCode: 'Wrong123',
    pathname: '/b/Right456',
    exportedAt: 1_700_000_000_000,
  });
  const zone = createCsvExportArtifact({
    csv: '\ufeffText',
    fallbackBoardCode: 'Wrong123',
    pathname: '/b/Right456',
    zoneTitle: '😊 Good / ดี',
    exportedAt: 1_700_000_000_000,
  });

  assert.equal(room.fileName, 'retro-Right456-2023-11-14-22-13.csv');
  assert.equal(zone.fileName, 'retro-Right456-Good_ดี-2023-11-14-22-13.csv');
  assert.equal(zone.mimeType, 'text/csv;charset=utf-8');
});
