import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readRelayConfig } from './relay-config.js';
import { connectionFixture } from '../test-support/relay-connection-fixture.js';

const awarenessProtocol = createRequire(import.meta.url)('y-protocols/awareness');
const CLIENT_ID = 42;
const SERVER_CLIENT_ID = 999;
const FIRST_CLOCK = 1;
const STATE_BYTES = 10;
const FRAME = Buffer.from([0]);
const entry = (clock = FIRST_CLOCK) => ({ clientId: CLIENT_ID, clock, stateBytes: STATE_BYTES, stateIsNull: false });

test('awareness plans commit after parse, first connection owns identity, close reclaims metadata', async t => {
  const doc = { conns: new Map(), awareness: { clientID: SERVER_CLIENT_ID, states: new Map(), meta: new Map() } };
  let entries = [entry()];
  const parsed = [];
  const fixture = await connectionFixture(t, {
    inspection: () => ({ kind: 'awareness', entries }),
    parse: conn => { parsed.push(conn); doc.awareness.states.set(CLIENT_ID, {}); doc.awareness.meta.set(CLIENT_ID, { clock: entries[0].clock }); },
  });
  const first = fixture.connect(doc);
  const second = fixture.connect(doc);
  first.conn.emit('message', FRAME);
  assert.deepEqual([...first.context.awarenessClientIds], [CLIENT_ID]);
  entries = [entry(FIRST_CLOCK + 1)];
  second.conn.emit('message', FRAME);
  assert.deepEqual(parsed, [first.conn], 'foreign identity frame never reaches upstream');
  assert.equal(second.context.awarenessClientIds.size, 0);
  t.mock.method(awarenessProtocol, 'removeAwarenessStates', (_awareness, ids) => {
    for (const id of ids) doc.awareness.states.delete(id);
  });
  first.conn.emit('close');
  assert.equal(doc.awareness.meta.has(CLIENT_ID), false);
  second.conn.emit('message', FRAME);
  assert.deepEqual(parsed, [first.conn, second.conn]);
});

test('a parser failure does not commit planned identity ownership', async t => {
  const doc = { conns: new Map(), awareness: { clientID: SERVER_CLIENT_ID, states: new Map(), meta: new Map() } };
  const fixture = await connectionFixture(t, {
    inspection: () => ({ kind: 'awareness', entries: [entry()] }),
    parse: () => { throw new Error('upstream failure'); },
  });
  const { conn, context } = fixture.connect(doc);
  assert.throws(() => conn.emit('message', FRAME), /upstream failure/);
  assert.equal(context.awarenessClientIds.size, 0);
});

const limits = readRelayConfig();
for (const [name, entries] of [
  ['reserved server identity', [{ ...entry(), clientId: SERVER_CLIENT_ID }]],
  ['identity count limit', Array.from({ length: limits.MAX_AWARENESS_IDS_PER_CONNECTION + 1 }, (_, index) => ({ ...entry(), clientId: index + CLIENT_ID }))],
  ['room byte limit', [{ ...entry(), stateBytes: limits.MAX_AWARENESS_ROOM_BYTES + 1 }]],
]) {
  test(`awareness rejects ${name} without partial ownership`, async t => {
    let parses = 0;
    const fixture = await connectionFixture(t, {
      inspection: () => ({ kind: 'awareness', entries }),
      parse: () => { parses += 1; },
    });
    const doc = { conns: new Map(), awareness: { clientID: SERVER_CLIENT_ID, states: new Map(), meta: new Map() } };
    const { conn, context } = fixture.connect(doc);
    conn.emit('message', FRAME);
    assert.deepEqual(conn.closes, [[1008, 'protocol policy']]);
    assert.equal(parses, 0);
    assert.equal(context.awarenessClientIds.size, 0);
  });
}
