import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
