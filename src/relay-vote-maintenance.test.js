import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PLAYER_PRESENCE_STALE_MS } from './player-cursors.js';
import { finalizeRelayVotes, maintainRoomVotes } from './relay-vote-maintenance.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const DEADLINE_MS = 100;
const ZONE_WIDTH_PX = 600;
const ZONE_HEIGHT_PX = 500;

test('future and invalid deadlines leave room state untouched', () => {
  const doc = new Y.Doc();
  try {
    for (const [id, endsAt] of [['future', DEADLINE_MS + 1], ['invalid', NaN]]) {
      const zone = new Y.Map();
      doc.getMap('items').set(id, zone);
      zone.set('type', 'zone');
      zone.set('voteTimer', { endsAt });
      zone.set('text', new Y.Text('text'));
    }
    const before = Y.encodeStateAsUpdate(doc);
    finalizeRelayVotes(doc, Y, DEADLINE_MS, () => assert.fail('unexpected invalid geometry'));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { doc.destroy(); }
});

test('expired vote finalization is durable, ordered by votes, and idempotent', () => {
  const doc = new Y.Doc();
  try {
    const records = {
      zone: { type: 'zone', x: 0, y: 0, w: ZONE_WIDTH_PX, h: ZONE_HEIGHT_PX, voteTimer: { endsAt: DEADLINE_MS } },
      a: { type: 'sticky', x: 20, y: 120, parentZoneId: 'zone' },
      b: { type: 'sticky', x: 40, y: 140, parentZoneId: 'zone' },
    };
    for (const [id, record] of Object.entries(records)) doc.getMap('items').set(id, new Y.Map(Object.entries(record)));
    doc.getMap('kv').set('s||vote:b:voter', true);
    finalizeRelayVotes(doc, Y, DEADLINE_MS, () => assert.fail('valid geometry was rejected'));
    const items = doc.getMap('items');
    assert.equal(items.get('zone').get('voteTimer'), null);
    assert.equal(items.get('zone').get('lastResultsAt'), DEADLINE_MS);
    assert.ok(items.get('b').get('x') < items.get('a').get('x'));
    const final = Y.encodeStateAsUpdate(doc);
    finalizeRelayVotes(doc, Y, DEADLINE_MS, () => assert.fail('unexpected geometry check'));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), final);
  } finally { doc.destroy(); }
});

test('room failures report the failing room and continue the pass', () => {
  const errors = [];
  const visited = [];
  const failure = new Error('invalid room');
  maintainRoomVotes(new Map([['bad', {}], ['good', {}]]), (name) => {
    if (name === 'bad') throw failure;
    visited.push(name);
  }, DEADLINE_MS, (name, err) => errors.push({ name, err }));
  assert.deepEqual(visited, ['good']);
  assert.deepEqual(errors, [{ name: 'bad', err: failure }]);
});

test('relay snapshots awareness only after expiry, missing awareness is optional', () => {
  const doc = new Y.Doc();
  let reads = 0;
  doc.awareness = { getStates: () => { reads += 1; return new Map([[1, { user: { userId: 'present', name: 'Present' } }]]); } };
  try {
    const zone = new Y.Map(Object.entries({ type: 'zone', x: 0, y: 0, w: ZONE_WIDTH_PX, h: ZONE_HEIGHT_PX,
      voteTimer: { startedAt: 10, endsAt: DEADLINE_MS, showNonVoters: true } }));
    doc.getMap('items').set('zone', zone);
    finalizeRelayVotes(doc, Y, DEADLINE_MS - 1, () => assert.fail('geometry'));
    assert.equal(reads, 0);
    finalizeRelayVotes(doc, Y, DEADLINE_MS, () => assert.fail('geometry'));
    assert.equal(reads, 1);
    assert.equal(zone.get('voteResults').presentCount, 1);
    assert.deepEqual(zone.get('voteResults').participants, [{ userId: 'present', name: 'Present', votes: 0 }]);
  } finally { doc.destroy(); }
});

test('relay excludes expired protocol slots and merges duplicate users by the shared presence rule', () => {
  const doc = new Y.Doc();
  const finalizedAt = 100_000;
  const states = new Map([
    [1, { user: { userId: 'stale', name: 'Expired', lastSeen: finalizedAt } }],
    [2, { user: { userId: 'live', name: 'A older tab', lastSeen: 1 } }],
    [3, { user: { userId: 'live', name: 'Z newest tab', lastSeen: 2 } }],
  ]);
  doc.awareness = { getStates: () => states,
    meta: new Map([[1, { lastUpdated: finalizedAt - PLAYER_PRESENCE_STALE_MS }], [2, { lastUpdated: finalizedAt }], [3, { lastUpdated: finalizedAt }]]) };
  try {
    const zone = new Y.Map(Object.entries({ type: 'zone', x: 0, y: 0, w: ZONE_WIDTH_PX, h: ZONE_HEIGHT_PX,
      voteTimer: { startedAt: 10, endsAt: finalizedAt, showNonVoters: true } }));
    doc.getMap('items').set('zone', zone);
    finalizeRelayVotes(doc, Y, finalizedAt, () => assert.fail('geometry'));
    assert.deepEqual(zone.get('voteResults').participants, [{ userId: 'live', name: 'Z newest tab', votes: 0 }]);
    assert.equal(zone.get('voteResults').presentCount, 1);
  } finally { doc.destroy(); }
});
