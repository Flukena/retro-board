import test from 'node:test';
import assert from 'node:assert/strict';

import { createCsvExportArtifact, buildBoardCsv, buildZoneCsv, createJsonBackupArtifact, exportFileName } from './board-backup.js';
import { normalizeImportManifest } from '../../domain/import-schema.js';

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

const CSV_LABELS = {
  zone: 'Zone', text: 'Text', author: 'Author', votes: 'Votes', color: 'Color',
  createdAt: 'Created At', hidden: '[hidden]', unassigned: '(no zone)', untitledZone: '(untitled)',
};
const CSV_VIEWER = 'viewer';
const CSV_ITEMS = [
  { id: 'outer', type: 'zone', title: 'Outer', x: 0, y: 0, w: 800, h: 800 },
  { id: 'inner', type: 'zone', title: 'Inner', x: 10, y: 10, w: 400, h: 400, parentZoneId: 'outer' },
  { id: 'low', type: 'sticky', x: 20, y: 20, w: 100, h: 100, text: '=SUM(A1)', authorName: 'A"B', color: 0, parentZoneId: 'inner' },
  { id: 'high', type: 'sticky', x: 20, y: 20, w: 100, h: 100, text: 'line,one\nline two', authorName: 'Ada', color: 3, createdAt: 1, parentZoneId: 'inner' },
  { id: 'private', type: 'sticky', x: 500, y: 500, w: 100, h: 100, text: 'secret', authorName: 'Owner', authorId: 'owner', private: true, parentZoneId: 'outer' },
  { id: 'loose', type: 'sticky', x: 1000, y: 1000, w: 100, h: 100, text: 'Loose', color: 99 },
];

test('pure CSV builders preserve Excel BOM, CRLF, formula defense, escaping and vote order', () => {
  const board = { items: CSV_ITEMS, allRevealed: false };
  const votes = new Map([['high', new Set(['one', 'two'])]]);
  const csv = buildZoneCsv(CSV_ITEMS[1], board, votes, CSV_VIEWER, CSV_LABELS);
  assert.equal(csv, '\uFEFFText,Author,Votes,Color,Created At\r\n"line,one\nline two",Ada,2,blue,1970-01-01T00:00:00.001Z\r\n\'=SUM(A1),"A""B",0,yellow,');
  assert.equal(CSV_ITEMS[2].text, '=SUM(A1)');
});

test('whole-board CSV keeps nested owners and board zone order, redacts private text and appends unassigned cards', () => {
  const csv = buildBoardCsv({ items: CSV_ITEMS, allRevealed: false }, new Map(), CSV_VIEWER, CSV_LABELS);
  assert.match(csv, /^\uFEFFZone,Text,Author,Votes,Color,Created At\r\nOuter,\[hidden\],Owner,0,yellow,/);
  assert.doesNotMatch(csv, /secret/);
  assert.ok(csv.indexOf('Outer,[hidden]') < csv.indexOf('Inner,'));
  assert.ok(csv.endsWith('(no zone),Loose,,0,99,'));
  const ownerCsv = buildBoardCsv({ items: CSV_ITEMS }, new Map(), 'owner', CSV_LABELS);
  assert.match(ownerCsv, /Outer,secret,/);
});

test('JSON backup round-trips the board title through the import decoder', () => {
  const artifact = createJsonBackupArtifact({
    fallbackBoardCode: 'Room1234', pathname: '/b/Room1234', exportedAt: 1_700_000_000_000,
    board: { items: [], title: 'ทีม A · Sprint 42' }, votes: {}, comments: {}, customTemplates: [],
  });
  const payload = JSON.parse(artifact.contents);
  assert.equal(normalizeImportManifest(payload, payload.exportedAt).boardMeta.title, 'ทีม A · Sprint 42');
});

test('JSON backup round-trips sticky action-item fields through the import decoder', () => {
  const actionSticky = {
    id: 'sticky-a', type: 'sticky', x: 0, y: 0, w: 200, h: 180, text: 'Fix CI',
    actionItem: true, actionOwner: 'Nok', actionDue: '2026-11-30', actionDone: false,
  };
  const artifact = createJsonBackupArtifact({
    fallbackBoardCode: 'Room1234', pathname: '/b/Room1234', exportedAt: 1_700_000_000_000,
    board: { items: [actionSticky] }, votes: {}, comments: {}, customTemplates: [],
  });
  const payload = JSON.parse(artifact.contents);
  const [item] = normalizeImportManifest(payload, payload.exportedAt).items;
  assert.equal(item.actionItem, true);
  assert.equal(item.actionOwner, 'Nok');
  assert.equal(item.actionDue, '2026-11-30');
  assert.equal(item.actionDone, false);
});

test('summary and image exports share the CSV naming scheme with their own extension', () => {
  const name = exportFileName({ fallbackBoardCode: 'Room1234', pathname: '/b/Room1234', exportedAt: 1_700_000_000_000, extension: 'md' });
  assert.equal(name, 'retro-Room1234-2023-11-14-22-13.md');
});

test('JSON backup round-trips the mood round and its answers through the import decoder', () => {
  const moodCheck = { id: 'round1', startedAt: 1_700_000_000_000, open: false };
  const moods = { 'user-a': 4, 'user-b': 1, 'user-c': 4 };
  const artifact = createJsonBackupArtifact({
    fallbackBoardCode: 'Room1234', pathname: '/b/Room1234', exportedAt: 1_700_000_000_000,
    board: { items: [], moodCheck }, votes: {}, comments: {}, moods, customTemplates: [],
  });
  const payload = JSON.parse(artifact.contents);
  assert.deepEqual(payload.moods, moods);
  const manifest = normalizeImportManifest(payload, payload.exportedAt);
  assert.deepEqual(manifest.boardMeta.moodCheck, moodCheck);
  assert.deepEqual(Object.fromEntries(manifest.moodEntries.map((entry) => [entry.userId, entry.score])), moods);
  assert.ok(manifest.moodEntries.every((entry) => entry.roundId === 'round1'));
});
