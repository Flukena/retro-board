import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_TEXT_MAX_LENGTH,
  IMPORT_COORDINATE_MAX_ABS,
  IMPORT_DIMENSION_MAX,
  IMPORT_MAX_TEMPLATE_ZONES,
  IMAGE_SOURCE_MAX_DIMENSION,
  TEMPLATE_NAME_MAX_LENGTH,
  ZONE_TITLE_MAX_LENGTH,
} from './security-boundaries.js';
import { normalizeCustomTemplates, normalizeImportManifest } from './import-schema.js';

const importedAt = 1_700_000_000_000;
const imageId = 'f98dcb70-f794-4b1a-9d4d-09fd5b4cd9a4';

const validManifest = () => ({
  board: {
    items: [
      {
        id: 'zone-1', type: 'zone', x: 0, y: 0, w: 500, h: 400,
        title: 'Ideas', color: 3, locked: false, revealed: null, unknown: 'drop me',
      },
      {
        id: 'sticky-1', type: 'sticky', x: 20, y: 60, w: 200, h: 180,
        parentZoneId: 'zone-1', text: 'Ship it', private: true, color: 1,
        authorId: 'user-1', authorName: 'Ada', unexpected: { nested: true },
      },
      {
        id: 'image-1', type: 'image', x: 230, y: 60, w: 160, h: 100,
        parentZoneId: 'zone-1', src: `/images/${imageId}.png`, natW: 640, natH: 400,
      },
    ],
    timer: { running: true, endsAt: Number.MAX_SAFE_INTEGER },
    editingLocked: true,
    votingLocked: false,
    allRevealed: false,
    lastResultsAt: importedAt - 1,
  },
  votes: { 'sticky-1': ['user-1'] },
  comments: {
    'sticky-1': [{
      id: 'comment-1', authorId: 'user-1', authorName: 'Ada', text: 'Looks good', createdAt: importedAt,
    }],
  },
  customTemplates: [{
    id: 'template-1',
    name: '  Team retro  ',
    zones: [{ title: 'Start', color: 2, x: 0, y: 0, w: 300, h: 200, unknown: 'drop me' }],
    createdAt: importedAt,
    unknown: 'drop me',
  }],
});

test('normalizes a manifest into bounded whitelisted records', () => {
  const normalized = normalizeImportManifest(validManifest(), importedAt);

  assert.equal(normalized.items.length, 3);
  assert.equal(normalized.items[0].unknown, undefined);
  assert.equal(normalized.items[0].revealed, undefined);
  assert.equal(normalized.items[1].unexpected, undefined);
  assert.equal(normalized.items[2].src, `/images/${imageId}.png`);
  assert.deepEqual(normalized.voteEntries, [{ itemId: 'sticky-1', userId: 'user-1' }]);
  assert.equal(normalized.commentEntries[0].comment.text, 'Looks good');
  assert.deepEqual(normalized.boardMeta, {
    timer: null,
    editingLocked: true,
    votingLocked: false,
    allRevealed: false,
    lastResultsAt: importedAt - 1,
  });
  assert.equal(normalized.customTemplates[0].name, 'Team retro');
  assert.deepEqual(normalized.customTemplates[0].zones[0], {
    title: 'Start', color: 2, x: 0, y: 0, w: 300, h: 200,
  });
});

test('recovers omitted legacy item geometry into a deterministic area', () => {
  const manifest = {
    board: {
      items: [
        { id: 'positioned', type: 'sticky', x: 0, y: 0, w: 200, h: 180, text: 'Existing' },
        { id: 'legacy-zone', type: 'zone', title: '', color: 0 },
        { id: 'legacy-sticky', type: 'sticky', w: 200, h: 180, text: 'Recovered' },
      ],
    },
  };

  const first = normalizeImportManifest(manifest, importedAt);
  const second = normalizeImportManifest(manifest, importedAt);
  const recovered = first.items.slice(1);

  assert.deepEqual(first.geometryRepairs, { positions: 2, zoneDimensions: 1 });
  assert.deepEqual(recovered.map(({ x, y }) => [x, y]), second.items.slice(1).map(({ x, y }) => [x, y]));
  assert.ok(recovered.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  assert.deepEqual(
    recovered.find(({ type }) => type === 'zone') && [
      recovered.find(({ type }) => type === 'zone').w,
      recovered.find(({ type }) => type === 'zone').h,
    ],
    [1200, 1080],
  );
  const overlaps = (a, b) => (
    a.x < b.x + (b.w || (b.type === 'sticky' ? 200 : 100))
    && a.x + (a.w || (a.type === 'sticky' ? 200 : 100)) > b.x
    && a.y < b.y + (b.h || (b.type === 'sticky' ? 180 : 100))
    && a.y + (a.h || (a.type === 'sticky' ? 180 : 100)) > b.y
  );
  recovered.forEach((item) => {
    assert.equal(overlaps(item, first.items[0]), false);
  });
  assert.equal(overlaps(recovered[0], recovered[1]), false);
  assert.equal(Object.hasOwn(manifest.board.items[1], 'x'), false);
  assert.equal(Object.hasOwn(manifest.board.items[1], 'w'), false);
  assert.equal(Object.hasOwn(manifest.board.items[2], 'x'), false);
  assert.equal(first.items[0].x, 0);
});

test('rejects overlong text, titles, coordinates, and dimensions', () => {
  const cases = [
    (manifest) => { manifest.board.items[1].text = 'x'.repeat(BOARD_TEXT_MAX_LENGTH + 1); },
    (manifest) => { manifest.board.items[0].title = 'x'.repeat(ZONE_TITLE_MAX_LENGTH + 1); },
    (manifest) => { manifest.board.items[1].x = IMPORT_COORDINATE_MAX_ABS + 1; },
    (manifest) => { manifest.board.items[0].w = IMPORT_DIMENSION_MAX + 1; },
  ];
  cases.forEach((mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    assert.throws(() => normalizeImportManifest(manifest, importedAt));
  });
  const explicitNullCoordinate = { board: { items: [{
    id: 'null-coordinate', type: 'sticky', x: null, text: 'Do not silently repair explicit invalid data',
  }] } };
  assert.throws(() => normalizeImportManifest(explicitNullCoordinate, importedAt), /invalid coordinates/);
});

test('rejects unsafe image sources and oversized decoded image declarations', () => {
  const unsafe = validManifest();
  unsafe.board.items[2].src = 'https://tracker.example/pixel.png';
  assert.throws(() => normalizeImportManifest(unsafe, importedAt), /invalid src/);

  const oversized = validManifest();
  oversized.board.items[2].natW = IMAGE_SOURCE_MAX_DIMENSION + 1;
  assert.throws(() => normalizeImportManifest(oversized, importedAt), /natural dimensions/);
});

test('validates custom templates deeply and enforces count and text limits', () => {
  assert.throws(() => normalizeCustomTemplates([null], importedAt), /not an object/);
  assert.throws(() => normalizeCustomTemplates([{
    id: 'template-1', name: 'x'.repeat(TEMPLATE_NAME_MAX_LENGTH + 1), zones: [{}],
  }], importedAt), /too long/);
  assert.throws(() => normalizeCustomTemplates([{
    id: 'template-1', name: 'Valid', zones: [{ title: '', color: 0, x: 0, y: 0, w: 0, h: 100 }],
  }], importedAt), /invalid dimensions/);
  assert.throws(() => normalizeCustomTemplates([{
    id: 'template-1',
    name: 'Valid',
    zones: Array.from({ length: IMPORT_MAX_TEMPLATE_ZONES + 1 }, () => (
      { title: '', color: 0, x: 0, y: 0, w: 100, h: 100 }
    )),
  }], importedAt), /too many zones/);
});
