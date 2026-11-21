import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionFixture } from '../test-support/relay-connection-fixture.js';
import { RoomFence } from './room-fence.js';

const FRAME = Buffer.from([0]);
const SERVER_SETUP_CLOSE_CODE = 1011;

for (const parserCount of [0, 2]) {
  test(`connection refuses ${parserCount} newly attached upstream parsers`, async t => {
    const counts = [];
    t.mock.method(console, 'error', (message, fields) => {
      if (message === '[yjs] unexpected message-listener count') counts.push(fields.count);
    });
    const fixture = await connectionFixture(t, { parserCount });
    const { conn } = fixture.connect({ conns: new Map() });
    assert.deepEqual(conn.closes, [[SERVER_SETUP_CLOSE_CODE, 'server setup error']]);
    assert.deepEqual(counts, [parserCount]);
  });
}

test('connection wraps one new parser and preserves pre-existing message listeners', async t => {
  const calls = [];
  const fixture = await connectionFixture(t, { parse: () => calls.push('upstream') });
  const { conn } = fixture.connect({ conns: new Map() }, {}, [() => calls.push('existing')]);
  conn.emit('message', FRAME);
  assert.deepEqual(calls, ['existing', 'upstream']);
  assert.deepEqual(conn.closes, []);
});

test('fenced room frames stop before admission or upstream parsing', async t => {
  t.mock.method(RoomFence.prototype, 'isFenced', () => true);
  const fixture = await connectionFixture(t, {
    inspection: () => assert.fail('fenced frame reached admission'),
    parse: () => assert.fail('fenced frame reached parser'),
  });
  const { conn } = fixture.connect({ conns: new Map() });
  conn.emit('message', FRAME);
  assert.deepEqual(conn.closes, []);
});

test('connection without a resident doc closes with server setup error', async t => {
  const fixture = await connectionFixture(t);
  const { conn } = fixture.connect(undefined);
  assert.deepEqual(conn.closes, [[SERVER_SETUP_CLOSE_CODE, 'server setup error']]);
});
