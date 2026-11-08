import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PLAYER_PRESENCE_STALE_MS } from './awareness-liveness.js';
import { finalizeExpiredVotes } from './vote-expiry.js';

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
    finalizeExpiredVotes(doc, Y, doc.awareness, DEADLINE_MS, () => assert.fail('unexpected invalid geometry'));
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
    finalizeExpiredVotes(doc, Y, doc.awareness, DEADLINE_MS, () => assert.fail('valid geometry was rejected'));
    const items = doc.getMap('items');
    assert.equal(items.get('zone').get('voteTimer'), null);
    assert.equal(items.get('zone').get('lastResultsAt'), DEADLINE_MS);
    assert.ok(items.get('b').get('x') < items.get('a').get('x'));
    const final = Y.encodeStateAsUpdate(doc);
    finalizeExpiredVotes(doc, Y, doc.awareness, DEADLINE_MS, () => assert.fail('unexpected geometry check'));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), final);
  } finally { doc.destroy(); }
});

test('relay snapshots awareness only after expiry, missing awareness is optional', () => {
  const doc = new Y.Doc();
  let reads = 0;
  doc.awareness = { getStates: () => { reads += 1; return new Map([[1, { user: { userId: 'present', name: 'Present' } }]]); } };
  try {
    const zone = new Y.Map(Object.entries({ type: 'zone', x: 0, y: 0, w: ZONE_WIDTH_PX, h: ZONE_HEIGHT_PX,
      voteTimer: { startedAt: 10, endsAt: DEADLINE_MS, showNonVoters: true } }));
    doc.getMap('items').set('zone', zone);
    finalizeExpiredVotes(doc, Y, doc.awareness, DEADLINE_MS - 1, () => assert.fail('geometry'));
    assert.equal(reads, 0);
    finalizeExpiredVotes(doc, Y, doc.awareness, DEADLINE_MS, () => assert.fail('geometry'));
    assert.equal(reads, 1);
    assert.equal(zone.get('voteResults').presentCount, 1);
    assert.deepEqual(zone.get('voteResults').participants, [{ userId: 'present', name: 'Present', votes: 0 }]);
  } finally { doc.destroy(); }
});

test('relay excludes expired slots and normalizes result names while live presence still selects the newest tab', () => {
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
    finalizeExpiredVotes(doc, Y, doc.awareness, finalizedAt, () => assert.fail('geometry'));
    assert.deepEqual(zone.get('voteResults').participants, [{ userId: 'live', name: 'A older tab', votes: 0 }]);
    assert.equal(zone.get('voteResults').presentCount, 1);
  } finally { doc.destroy(); }
});

function finalizeParticipantFixture(states, showNonVoters = true) {
  const doc = new Y.Doc();
  doc.awareness = { getStates: () => states,
    meta: new Map([...states.keys()].map((id) => [id, { lastUpdated: DEADLINE_MS }])) };
  try {
    const zone = new Y.Map(Object.entries({ type: 'zone', x: 0, y: 0, w: ZONE_WIDTH_PX, h: ZONE_HEIGHT_PX,
      voteTimer: { startedAt: 1, endsAt: DEADLINE_MS, showNonVoters } }));
    doc.getMap('items').set('zone', zone);
    finalizeExpiredVotes(doc, Y, doc.awareness, DEADLINE_MS, () => assert.fail('valid geometry rejected'));
    return { timer: zone.get('voteTimer'), result: zone.get('voteResults') };
  } finally { doc.destroy(); }
}

test('malformed JSON cursor and view cannot prevent expired votes from persisting results', () => {
  const invalidNumber = JSON.parse('{"toString":null,"valueOf":null}');
  const malformedMotion = [
    { cursor: { x: invalidNumber, y: 0, updatedAt: DEADLINE_MS } },
    { view: { zoom: invalidNumber, updatedAt: DEADLINE_MS } },
  ];
  for (const showNonVoters of [false, true]) {
    for (const motion of malformedMotion) {
      const { timer, result } = finalizeParticipantFixture(new Map([[1, {
        user: { userId: 'present', name: 'Present' }, ...motion,
      }]]), showNonVoters);
      assert.equal(timer, null);
      assert.equal(result.finalizedAt, DEADLINE_MS);
      assert.equal(result.presentCount, 1);
      assert.equal(Object.hasOwn(result, 'participants'), showNonVoters);
    }
  }
});

test('relay results are identical when equal-lastSeen duplicate awareness entries are reversed', () => {
  const entries = [
    [1, { user: { userId: 'person', name: 'Zed', lastSeen: 1 } }],
    [2, { user: { userId: 'person', name: 'Ada', lastSeen: 1 } }],
  ];
  const forward = finalizeParticipantFixture(new Map(entries)).result;
  const reverse = finalizeParticipantFixture(new Map([...entries].reverse())).result;
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.participants, [{ userId: 'person', name: 'Ada', votes: 0 }]);
});

function timedZoneDoc(voteTimer) {
  const doc = new Y.Doc();
  doc.getMap('items').set('zone', new Y.Map(Object.entries({
    type: 'zone', x: 0, y: 0, w: ZONE_WIDTH_PX, h: ZONE_HEIGHT_PX, voteTimer,
  })));
  return doc;
}

const noAwareness = { getStates: () => new Map(), meta: new Map() };

test('a stale timer generation leaves a restarted vote untouched', () => {
  const doc = timedZoneDoc({ startedAt: 50, endsAt: DEADLINE_MS });
  try {
    const before = Y.encodeStateAsUpdate(doc);
    finalizeExpiredVotes(doc, Y, noAwareness, DEADLINE_MS, () => assert.fail('geometry'),
      { timerGeneration: { startedAt: 1, endsAt: DEADLINE_MS } });
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { doc.destroy(); }
});

test('a matching timer generation finalizes the zone', () => {
  const doc = timedZoneDoc({ startedAt: 50, endsAt: DEADLINE_MS });
  try {
    finalizeExpiredVotes(doc, Y, noAwareness, DEADLINE_MS, () => assert.fail('geometry'),
      { timerGeneration: { startedAt: 50, endsAt: DEADLINE_MS } });
    assert.equal(doc.getMap('items').get('zone').get('voteTimer'), null);
  } finally { doc.destroy(); }
});

test('missing awareness is treated as nobody present', () => {
  const doc = timedZoneDoc({ startedAt: 50, endsAt: DEADLINE_MS, showNonVoters: true });
  try {
    finalizeExpiredVotes(doc, Y, undefined, DEADLINE_MS, () => assert.fail('geometry'));
    assert.equal(doc.getMap('items').get('zone').get('voteResults').presentCount, 0);
  } finally { doc.destroy(); }
});
