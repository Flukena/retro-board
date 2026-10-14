import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { boardVoteIsOpen } from './vote-timing.js';
import { COMMENT_AUTHOR_NAME_MAX_LEN, COMMENT_ID_MAX_LEN } from './comment-schema.js';
import { DISPLAY_NAME_MAX_LENGTH } from './security-boundaries.js';
import { decodeRemoteBoard } from './remote-board-decoder.js';

const STICKY = Object.freeze({ id: 'sticky', type: 'sticky', x: 0, y: 0, text: 'hello',
  authorName: 'Alice', fontColor: '#ABCDEF', private: true });
const TIMER = Object.freeze({ startedAt: 100, endsAt: 200, voteLimit: 3,
  hideResults: true, showNonVoters: true });
const ZONE = Object.freeze({ id: 'zone', type: 'zone', title: 'Ideas', x: 0, y: 0,
  w: 500, h: 500, voteTimer: TIMER, revealed: null, votingLocked: false });

test('valid runtime values survive unchanged, including live vote timers and reveal inheritance', () => {
  const items = Object.freeze([STICKY, ZONE]);
  const meta = Object.freeze({ allRevealed: false, adminUserId: 'alice', timer: TIMER });
  assert.deepEqual(decodeRemoteBoard(items, meta), { ...meta, items });
});

test('malformed fields cannot become React children, styles or voting controls', () => {
  const badPatches = [
    { text: {} }, { authorName: {} }, { x: NaN }, { color: {} }, { fontSize: {} },
    { parentZoneId: {} }, { voteTimer: { voteLimit: {} } }, { createdAt: {} },
    { lastResultsAt: {} }, { votingLocked: {} }, { id: '__proto__' },
  ];
  for (const patch of badPatches) {
    assert.deepEqual(decodeRemoteBoard([{ ...STICKY, ...patch }, ZONE], {}).items, [ZONE]);
  }
  assert.deepEqual(decodeRemoteBoard([{ ...ZONE, title: {} }, STICKY], {}).items, [STICKY]);
});

test('metadata is allowlisted and malformed known fields are omitted', () => {
  const meta = JSON.parse('{"items":5,"adminName":{},"timer":{"endsAt":{}},"allRevealed":{},"__proto__":{}}');
  assert.deepEqual(decodeRemoteBoard([STICKY], meta), { items: [STICKY] });
});

const VOTE_CHECK_NOW_MS = 150;
const SHA256_HEX_LENGTH = 64;

function decodePeerTimer(timer, context) {
  const peer = new Y.Doc();
  const receiver = new Y.Doc();
  context.after(() => { peer.destroy(); receiver.destroy(); });
  peer.getMap('items').set(ZONE.id, new Y.Map(Object.entries({ ...ZONE, voteTimer: timer })));
  Y.applyUpdate(receiver, Y.encodeStateAsUpdate(peer));
  const received = Object.fromEntries(receiver.getMap('items').get(ZONE.id));
  const before = Y.encodeStateAsUpdate(receiver);
  const decoded = decodeRemoteBoard([received, STICKY], {});
  assert.deepEqual(Y.encodeStateAsUpdate(receiver), before, 'decoding must not repair canonical data');
  return decoded;
}

test('encoded peer timer prototypes cannot reach voting calculations', (context) => {
  const timer = JSON.parse('{"__proto__":{"endsAt":{"toString":{},"valueOf":{}}}}');
  const decoded = decodePeerTimer(timer, context);
  assert.doesNotThrow(() => boardVoteIsOpen(decoded.items, VOTE_CHECK_NOW_MS));
  assert.deepEqual(decoded.items, [STICKY]);
});

test('encoded nested Y.Map timers are rejected instead of treated as empty records', (context) => {
  const decoded = decodePeerTimer(new Y.Map([['endsAt', {}]]), context);
  assert.deepEqual(decoded.items, [STICKY]);
});

test('plain and null-prototype timers preserve valid values', () => {
  const timer = Object.assign(Object.create(null), TIMER);
  const zone = { ...ZONE, voteTimer: timer };
  assert.equal(decodeRemoteBoard([zone], {}).items[0], zone);
  assert.equal(boardVoteIsOpen([zone], VOTE_CHECK_NOW_MS), true);
});

test('remote display and identity strings enforce existing bounds without truncation', () => {
  const valid = { ...STICKY, authorName: 'a'.repeat(COMMENT_AUTHOR_NAME_MAX_LEN),
    authorId: 'a'.repeat(COMMENT_ID_MAX_LEN) };
  assert.equal(decodeRemoteBoard([valid], {}).items[0], valid);
  for (const patch of [
    { authorName: 'a'.repeat(COMMENT_AUTHOR_NAME_MAX_LEN + 1) },
    { authorId: 'a'.repeat(COMMENT_ID_MAX_LEN + 1) },
    { authorId: '__proto__' },
  ]) {
    assert.deepEqual(decodeRemoteBoard([{ ...STICKY, ...patch }], {}).items, []);
  }
  assert.equal(decodeRemoteBoard([{ ...STICKY, authorId: '' }], {}).items.length, 1);
});

test('oversized metadata strings are omitted while boundary-length values survive unchanged', () => {
  const valid = { adminName: 'a'.repeat(DISPLAY_NAME_MAX_LENGTH), adminPinHash: 'a'.repeat(SHA256_HEX_LENGTH) };
  assert.deepEqual(decodeRemoteBoard([], valid), { ...valid, items: [] });
  assert.deepEqual(decodeRemoteBoard([], {
    adminName: valid.adminName + 'a', adminPinHash: valid.adminPinHash + 'a',
  }), { items: [] });
});
