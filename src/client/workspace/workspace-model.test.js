import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_KIND } from '../../domain/room-ownership.js';
import {
  CARD_THUMBNAIL,
  RENAME_ACTION,
  WORKSPACE_SORT,
  cardThumbnailOf,
  renameActionOf,
  roomNameOf,
  visibleRooms,
} from './workspace-model.js';

const room = (overrides = {}) => ({
  code: 'aaaaaa',
  kind: ROOM_KIND.BOARD,
  locked: false,
  title: null,
  link: '/b/aaaaaa',
  createdAt: 1000,
  lastActiveAt: 1000,
  preview: null,
  ...overrides,
});
const codes = (rooms) => rooms.map((r) => r.code);
const zone = { x: 0, y: 0, w: 300, h: 200, color: 2 };

test('search matches title or code, ignoring case and surrounding spaces', () => {
  const rooms = [room({ code: 'k7m2qx', title: 'Other' }), room({ code: 'bbbbbb', title: 'Sprint 42' })];
  assert.deepEqual(codes(visibleRooms(rooms, { query: '  SPRINT ', locale: 'en' })), ['bbbbbb']);
  assert.deepEqual(codes(visibleRooms(rooms, { query: 'k7m2', locale: 'en' })), ['k7m2qx']);
  assert.equal(visibleRooms(rooms, { query: '   ', locale: 'en' }).length, 2);
});

test('search finds Thai titles', () => {
  const rooms = [room({ code: 'aaaaaa', title: 'ทบทวนสปรินต์' }), room({ code: 'bbbbbb', title: 'x' })];
  assert.deepEqual(codes(visibleRooms(rooms, { query: ' สปรินต์', locale: 'th' })), ['aaaaaa']);
});

test('recent sorts by lastActiveAt newest first, falling back to createdAt', () => {
  const rooms = [
    room({ code: 'old', createdAt: 100, lastActiveAt: 200 }),
    room({ code: 'new', createdAt: 100, lastActiveAt: 900 }),
    room({ code: 'nolast', createdAt: 500, lastActiveAt: null }),
  ];
  assert.deepEqual(codes(visibleRooms(rooms, { sort: WORKSPACE_SORT.RECENT, locale: 'en' })), ['new', 'nolast', 'old']);
});

test('created sorts newest first and ties sort by code', () => {
  const rooms = [
    room({ code: 'b', createdAt: 5 }),
    room({ code: 'c', createdAt: 9 }),
    room({ code: 'a', createdAt: 5 }),
  ];
  assert.deepEqual(codes(visibleRooms(rooms, { sort: WORKSPACE_SORT.CREATED, locale: 'en' })), ['c', 'a', 'b']);
});

test('name sorts with the given locale and uses the code for untitled rooms', () => {
  const thai = [room({ code: 'x1', title: 'ขยับ' }), room({ code: 'x2', title: 'กล้า' })];
  assert.deepEqual(codes(visibleRooms(thai, { sort: WORKSPACE_SORT.NAME, locale: 'th' })), ['x2', 'x1']);
  const mixed = [room({ code: 'zzzzzz' }), room({ code: 'm1', title: 'Beta' }), room({ code: 'aaaaaa' })];
  assert.deepEqual(codes(visibleRooms(mixed, { sort: WORKSPACE_SORT.NAME, locale: 'en' })), ['aaaaaa', 'm1', 'zzzzzz']);
});

test('name ties sort by code', () => {
  const rooms = [room({ code: 'b', title: 'Same' }), room({ code: 'a', title: 'Same' })];
  assert.deepEqual(codes(visibleRooms(rooms, { sort: WORKSPACE_SORT.NAME, locale: 'en' })), ['a', 'b']);
});

test('visibleRooms does not mutate the input array', () => {
  const rooms = [room({ code: 'b', createdAt: 1 }), room({ code: 'a', createdAt: 2 })];
  const snapshot = [...rooms];
  visibleRooms(rooms, { sort: WORKSPACE_SORT.CREATED, locale: 'en' });
  assert.deepEqual(rooms, snapshot);
});

test('roomNameOf falls back to the code', () => {
  assert.equal(roomNameOf(room({ title: 'Retro' })), 'Retro');
  assert.equal(roomNameOf(room({ code: 'k7m2qx' })), 'k7m2qx');
});

test('thumbnail: poker and locked rooms never show zones', () => {
  assert.equal(cardThumbnailOf(room({ kind: ROOM_KIND.POKER })).kind, CARD_THUMBNAIL.POKER);
  assert.equal(cardThumbnailOf(room({ locked: true, preview: { zones: [zone] } })).kind, CARD_THUMBNAIL.LOCKED);
});

test('thumbnail: valid preview shows its zones', () => {
  assert.deepEqual(cardThumbnailOf(room({ preview: { zones: [zone] } })), { kind: CARD_THUMBNAIL.ZONES, zones: [zone] });
});

test('thumbnail: missing or malformed preview is empty', () => {
  const empty = { kind: CARD_THUMBNAIL.EMPTY, zones: [] };
  assert.deepEqual(cardThumbnailOf(room({ preview: null })), empty);
  assert.deepEqual(cardThumbnailOf(room({ preview: 'x' })), empty);
  assert.deepEqual(cardThumbnailOf(room({ preview: { zones: 'x' } })), empty);
  assert.deepEqual(cardThumbnailOf(room({ preview: { zones: [] } })), empty);
  assert.deepEqual(cardThumbnailOf(room({ preview: { zones: [{ ...zone, w: Number.NaN }] } })), empty);
  assert.deepEqual(cardThumbnailOf(room({ preview: { zones: [null, 5] } })), empty);
});

test('thumbnail: re-validation drops bad zones and extra fields but keeps good ones', () => {
  const result = cardThumbnailOf(room({ preview: { zones: [{ ...zone, title: 'secret' }, { ...zone, h: Infinity }] } }));
  assert.deepEqual(result, { kind: CARD_THUMBNAIL.ZONES, zones: [zone] });
});

test('rename: poker hidden, locked disabled, plain board enabled', () => {
  assert.equal(renameActionOf(room({ kind: ROOM_KIND.POKER })), RENAME_ACTION.HIDDEN);
  assert.equal(renameActionOf(room({ locked: true })), RENAME_ACTION.DISABLED);
  assert.equal(renameActionOf(room()), RENAME_ACTION.ENABLED);
});

test('locked and poker rooms are named, searched and name-sorted by code, never title', () => {
  const locked = room({ code: 'lk1', locked: true, title: 'Secret' });
  const poker = room({ code: 'pk1', kind: ROOM_KIND.POKER, title: 'Estimate' });
  assert.equal(roomNameOf(locked), 'lk1');
  assert.equal(roomNameOf(poker), 'pk1');
  assert.deepEqual(visibleRooms([locked, poker], { query: 'secret', locale: 'en' }), []);
  assert.deepEqual(visibleRooms([locked, poker], { query: 'estimate', locale: 'en' }), []);
  const plain = room({ code: 'mm', title: 'Mid' });
  const lockedZ = room({ code: 'aa1', locked: true, title: 'Zulu' });
  assert.deepEqual(codes(visibleRooms([plain, lockedZ], { sort: WORKSPACE_SORT.NAME, locale: 'en' })), ['aa1', 'mm']);
});

test('time sorts are deterministic with missing or invalid dates, missing sorts oldest', () => {
  const rooms = [
    room({ code: 'a', createdAt: 50, lastActiveAt: null }),
    room({ code: 'b', createdAt: 'x', lastActiveAt: undefined }),
    room({ code: 'c', createdAt: 10, lastActiveAt: '900' }),
    room({ code: 'd', createdAt: undefined, lastActiveAt: 70 }),
    room({ code: 'e', createdAt: 5, lastActiveAt: 5 }),
  ];
  const orders = { [WORKSPACE_SORT.RECENT]: ['d', 'a', 'c', 'e', 'b'], [WORKSPACE_SORT.CREATED]: ['a', 'c', 'e', 'b', 'd'] };
  const shuffles = [rooms, [...rooms].reverse(), [rooms[2], rooms[4], rooms[0], rooms[3], rooms[1]], [rooms[3], rooms[1], rooms[4], rooms[2], rooms[0]]];
  for (const [sort, expected] of Object.entries(orders)) {
    for (const input of shuffles) assert.deepEqual(codes(visibleRooms(input, { sort, locale: 'en' })), expected);
  }
});
