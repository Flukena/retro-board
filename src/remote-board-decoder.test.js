import test from 'node:test';
import assert from 'node:assert/strict';
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
