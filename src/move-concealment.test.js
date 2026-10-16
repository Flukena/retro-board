import test from 'node:test';
import assert from 'node:assert/strict';
import { isStickyHiddenForUser } from './board-visibility.js';
import { normalizeImportManifest } from './import-schema.js';
import { decodeRemoteItem } from './remote-board-decoder.js';
import { createJsonBackupArtifact } from './board-backup.js';
import { createBoardArchiveArtifact, readBoardArchive } from './board-archive.js';

// Fixture geometry in board pixels; identities and field values are wire goldens.
const SOURCE = { id: 'source', type: 'zone', x: 0, y: 0, w: 400, h: 400, revealed: false };
const DESTINATION = { id: 'destination', type: 'zone', x: 600, y: 0, w: 600, h: 600, revealed: true };
const CARD = { id: 'card', type: 'sticky', x: 20, y: 20, w: 100, h: 100,
  parentZoneId: SOURCE.id, private: true, authorId: 'author', text: 'Private thought' };
const MOVED = { ...CARD, x: 620, parentZoneId: DESTINATION.id };
const CONCEAL = [{ id: CARD.id, patch: { revealed: false } }];
const BEFORE = [SOURCE, DESTINATION, CARD];

for (const revealed of [true, false, null]) {
  test(`move into zone revealed=${revealed} preserves concealment`, async () => {
    const { concealEntriesForMove } = await import('./move-concealment.js');
    const destination = { ...DESTINATION, revealed };
    assert.deepEqual(concealEntriesForMove([SOURCE, destination, CARD],
      [SOURCE, destination, MOVED], false), revealed === true ? CONCEAL : []);
  });
}

test('nested inherited zone and its children remain concealed in a revealed parent', async () => {
  const { concealEntriesForMove } = await import('./move-concealment.js');
  const inner = { ...SOURCE, revealed: null, parentZoneId: null };
  const movedInner = { ...inner, x: DESTINATION.x, parentZoneId: DESTINATION.id };
  assert.deepEqual(concealEntriesForMove([inner, DESTINATION, CARD],
    [movedInner, DESTINATION, { ...MOVED, parentZoneId: inner.id }], false), CONCEAL);
});

test('moving or resizing a revealed zone over a legacy card conceals even an unmoved card', async () => {
  const { concealEntriesForMove } = await import('./move-concealment.js');
  const { parentZoneId: omitted, ...legacy } = CARD;
  assert.equal(omitted, SOURCE.id);
  assert.deepEqual(concealEntriesForMove([DESTINATION, legacy],
    [{ ...DESTINATION, x: SOURCE.x }, legacy], false), CONCEAL);
  const UNCOVERING_SIZE_PX = 10;
  const small = { ...DESTINATION, x: SOURCE.x, w: UNCOVERING_SIZE_PX, h: UNCOVERING_SIZE_PX };
  assert.deepEqual(concealEntriesForMove([small, legacy],
    [{ ...small, w: DESTINATION.w, h: DESTINATION.h }, legacy], false), CONCEAL);
});

test('visible, public, already concealed cards and explicit zone toggles produce no move override', async () => {
  const { concealEntriesForMove } = await import('./move-concealment.js');
  assert.deepEqual(concealEntriesForMove([{ ...SOURCE, revealed: true }, DESTINATION, CARD],
    [SOURCE, DESTINATION, MOVED], false), []);
  assert.deepEqual(concealEntriesForMove([SOURCE, DESTINATION, { ...CARD, private: false }],
    [SOURCE, DESTINATION, { ...MOVED, private: false }], false), []);
  assert.deepEqual(concealEntriesForMove([SOURCE, DESTINATION, { ...CARD, revealed: false }],
    [SOURCE, DESTINATION, { ...MOVED, revealed: false }], false), []);
  assert.deepEqual(concealEntriesForMove(BEFORE,
    [{ ...SOURCE, revealed: true }, DESTINATION, MOVED], false), []);
});

test('sticky conceal override hides from viewers in a revealed zone while author still sees', () => {
  const sticky = { ...MOVED, revealed: false };
  const items = [SOURCE, DESTINATION, sticky];
  assert.equal(isStickyHiddenForUser(sticky, items, true, 'viewer'), true);
  assert.equal(isStickyHiddenForUser(sticky, items, true, CARD.authorId), false);
  assert.equal(isStickyHiddenForUser({ ...sticky, private: false }, items, true, 'viewer'), false);
});

test('explicit reveal clears only private overrides in the effective owner chain', async () => {
  const { revealEntriesForZone } = await import('./move-concealment.js');
  const inner = { ...SOURCE, parentZoneId: DESTINATION.id, x: MOVED.x, revealed: false };
  const sticky = { ...MOVED, parentZoneId: inner.id, revealed: false };
  const other = { ...CARD, id: 'other', parentZoneId: null, revealed: false };
  const publicCard = { ...sticky, id: 'public', private: false };
  const items = [DESTINATION, inner, sticky, other, publicCard];
  assert.deepEqual(revealEntriesForZone(DESTINATION.id, { revealed: true }, items),
    [{ id: sticky.id, patch: { revealed: null } }]);
  assert.deepEqual(revealEntriesForZone(DESTINATION.id, { revealed: false }, items), []);
});

for (const revealed of [false, null]) {
  test(`sticky revealed=${revealed} survives decoder, import, JSON and ZIP exactly`, async () => {
    const sticky = { ...CARD, parentZoneId: null, revealed };
    assert.deepEqual(decodeRemoteItem(sticky), sticky);
    const board = { items: [sticky] };
    const decoded = normalizeImportManifest({ board });
    assert.equal(decoded.items[0].revealed, revealed);
    const json = createJsonBackupArtifact({ board });
    assert.equal(JSON.parse(json.contents).board.items[0].revealed, revealed);
    const zip = await createBoardArchiveArtifact({ board });
    assert.equal((await readBoardArchive(zip.blob)).items[0].revealed, revealed);
  });
}

for (const revealed of [true, 'false', 0, {}]) {
  test(`reject invalid sticky revealed=${JSON.stringify(revealed)} without repair`, () => {
    const sticky = { ...CARD, parentZoneId: null, revealed };
    assert.throws(() => normalizeImportManifest({ board: { items: [sticky] } }), /revealed/);
    assert.equal(decodeRemoteItem(sticky), null);
  });
}

test('throttled batches retain an unmoved legacy card override through subsequent frames', async () => {
  const { protectedItemEntries, applyItemEntries, mergeItemEntries } = await import('./move-concealment.js');
  const { parentZoneId: omitted, ...legacy } = CARD;
  assert.equal(omitted, SOURCE.id);
  const items = [DESTINATION, legacy];
  const first = protectedItemEntries(items, [{ id: DESTINATION.id, patch: { x: SOURCE.x } }], false);
  const optimistic = applyItemEntries(items, first);
  const next = protectedItemEntries(optimistic,
    mergeItemEntries(first, [{ id: DESTINATION.id, patch: { x: SOURCE.x, w: DESTINATION.w } }]), false);
  assert.deepEqual(next.find(entry => entry.id === CARD.id), CONCEAL[0]);
  assert.equal(applyItemEntries(items, next).find(item => item.id === CARD.id).revealed, false);
});

test('shrinking a hidden owner cannot reveal a private card under a revealed board', async () => {
  const { concealEntriesForMove } = await import('./move-concealment.js');
  const SHRUNK_SIZE_PX = 10;
  assert.deepEqual(concealEntriesForMove(BEFORE,
    [{ ...SOURCE, w: SHRUNK_SIZE_PX, h: SHRUNK_SIZE_PX }, DESTINATION, CARD], true), CONCEAL);
});
