import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRelayLifecycle, drainRelay, isRelayReady } from './relay-lifecycle.js';

const TEST_DRAIN_TIMEOUT_MS = 100;
const TEST_HTTP_GRACE_MS = 10;
const PRIVATE_ERROR = 'token-and-raw-doc-name';
const KEYED_ERROR_ID = 'keyed-error-id';

test('readiness requires healthy storage and a relay outside drain', () => {
  assert.equal(isRelayReady(null, false), true);
  assert.equal(isRelayReady(new Error(PRIVATE_ERROR), false), false);
  assert.equal(isRelayReady(null, true), false);
  assert.equal(isRelayReady(new Error(PRIVATE_ERROR), true), false);
});
const lifecycleFor = (drain) => {
  const logs = [];
  const exits = [];
  const starts = [];
  const lifecycle = createRelayLifecycle({
    drain, timeoutMs: TEST_DRAIN_TIMEOUT_MS, onStart: (reason) => starts.push(reason),
    log: { error: (...args) => logs.push(args) }, errorId: () => KEYED_ERROR_ID,
    exit: (code) => exits.push(code),
  });
  return { ...lifecycle, logs, exits, starts };
};

test('a fatal event during signal drain upgrades exit status without a second drain', async () => {
  let finish;
  const relay = lifecycleFor(() => new Promise((resolve) => { finish = resolve; }));
  const completion = relay.shutdown('SIGTERM');
  relay.fatal('uncaughtException', new Error(PRIVATE_ERROR));
  relay.shutdown('SIGTERM');
  finish();
  await completion;
  assert.deepEqual(relay.exits, [1]);
  assert.deepEqual(relay.starts, ['SIGTERM']);
  assert.equal(JSON.stringify(relay.logs).includes(PRIVATE_ERROR), false);
  assert.ok(JSON.stringify(relay.logs).includes(KEYED_ERROR_ID));
});

test('a throwing drain exits with failure and repeated fatal events do not retry it', async () => {
  let drains = 0;
  const relay = lifecycleFor(() => { drains += 1; throw new Error(PRIVATE_ERROR); });
  await relay.fatal('unhandledRejection', new Error(PRIVATE_ERROR));
  await relay.fatal('unhandledRejection', new Error(PRIVATE_ERROR));
  assert.equal(drains, 1);
  assert.deepEqual(relay.exits, [1]);
  assert.equal(JSON.stringify(relay.logs).includes(PRIVATE_ERROR), false);
});

test('ordinary signal drain exits successfully', async () => {
  const relay = lifecycleFor(async () => {});
  await relay.shutdown('SIGINT');
  assert.deepEqual(relay.exits, [0]);
});

test('a stuck drain still reaches the hard deadline', async () => {
  const relay = lifecycleFor(() => new Promise(() => {}));
  relay.shutdown('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, TEST_DRAIN_TIMEOUT_MS));
  assert.deepEqual(relay.exits, [1]);
});

test('drain closes upgraded sockets before awaiting HTTP and drains writes before storage', async () => {
  const events = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  let httpCallback;
  socket.close = (code) => {
    assert.equal(code, 1001);
    events.push('socket');
    socket.emit('close');
    httpCallback();
  };
  await drainRelay({
    server: { close: (callback) => { httpCallback = callback; }, closeAllConnections() {} },
    clients: new Set([socket]), httpGraceMs: TEST_HTTP_GRACE_MS, isBusy: () => false,
    compactions: () => [Promise.resolve().then(() => events.push('writes'))],
    destroyStorage: async () => events.push('storage'),
  });
  assert.deepEqual(events, ['socket', 'writes', 'storage']);
});
