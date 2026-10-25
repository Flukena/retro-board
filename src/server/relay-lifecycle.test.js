import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createRelayLifecycle, drainRelay, isRelayReady } from './relay-lifecycle.js';

const TEST_DRAIN_TIMEOUT_MS = 100;
const TEST_HTTP_GRACE_MS = 10;
const PRIVATE_ERROR = 'token-and-raw-doc-name';
const KEYED_ERROR_ID = 'keyed-error-id';
const CHILD_TIMEOUT_MS = 3_000;
const FAILURE_STATUS_LABEL = 'failure-status';

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
  const exitStatuses = [];
  const lifecycle = createRelayLifecycle({
    drain, timeoutMs: TEST_DRAIN_TIMEOUT_MS, onStart: (reason) => starts.push(reason),
    log: { error: (...args) => logs.push(args) }, errorId: () => KEYED_ERROR_ID,
    exit: (code) => exits.push(code),
    setExitCode: (code) => exitStatuses.push(code),
  });
  return { ...lifecycle, logs, exits, starts, exitStatuses };
};

test('a fatal event during signal drain upgrades exit status without a second drain', async () => {
  let finish;
  const relay = lifecycleFor(() => new Promise((resolve) => { finish = resolve; }));
  const completion = relay.shutdown('SIGTERM');
  relay.fatal('uncaughtException', new Error(PRIVATE_ERROR));
  assert.equal(relay.exitStatuses.at(-1), 1);
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

test('non-Error rejections with uncoercible values still start one fatal drain', async () => {
  const logs = [];
  const starts = [];
  const exits = [];
  const reasons = [Object.create(null), { toString() { throw new Error(PRIVATE_ERROR); } }];
  for (const reason of reasons) {
    const lifecycle = createRelayLifecycle({
      drain: async () => {}, onStart: (event) => starts.push(event), timeoutMs: TEST_DRAIN_TIMEOUT_MS,
      log: { error: (...args) => logs.push(args) }, errorId: (err) => String(err),
      exit: (code) => exits.push(code), setExitCode() {},
    });
    await lifecycle.fatal('unhandledRejection', reason);
  }
  assert.deepEqual(starts, ['unhandledRejection', 'unhandledRejection']);
  assert.deepEqual(exits, [1, 1]);
  assert.equal(logs.length, reasons.length);
  const errorIds = logs.map(([, details]) => details.errorId);
  assert.equal(typeof errorIds[0], 'string');
  assert.ok(errorIds[0].length > 0);
  assert.equal(errorIds[0], errorIds[1]);
  assert.equal(JSON.stringify(logs).includes(PRIVATE_ERROR), false);
});

test('throwing diagnostics cannot prevent fatal drain or failure exit', async () => {
  const starts = [];
  const exits = [];
  const lifecycle = createRelayLifecycle({
    drain: async () => {}, onStart: (reason) => starts.push(reason), timeoutMs: TEST_DRAIN_TIMEOUT_MS,
    log: { error() { throw new Error(PRIVATE_ERROR); } }, errorId: () => KEYED_ERROR_ID,
    exit: (code) => exits.push(code), setExitCode() {},
  });
  await lifecycle.fatal('uncaughtException', new Error(PRIVATE_ERROR));
  assert.deepEqual(starts, ['uncaughtException']);
  assert.deepEqual(exits, [1]);
});

test('an uncoercible drain failure and throwing diagnostic sink still exit once', async () => {
  const exits = [];
  const lifecycle = createRelayLifecycle({
    drain: () => { throw Object.create(null); }, onStart() {}, timeoutMs: TEST_DRAIN_TIMEOUT_MS,
    log: { error() { throw new Error(PRIVATE_ERROR); } }, errorId: (err) => String(err),
    exit: (code) => exits.push(code), setExitCode() {},
  });
  await lifecycle.shutdown('SIGTERM');
  await lifecycle.fatal('unhandledRejection', Object.create(null));
  assert.deepEqual(exits, [1]);
});

test('stalled fatal drain with no unrelated handles keeps its deadline and sets failure status immediately', () => {
  const moduleUrl = new URL('./relay-lifecycle.js', import.meta.url).href;
  const childSource = `
    import { createRelayLifecycle } from ${JSON.stringify(moduleUrl)};
    const lifecycle = createRelayLifecycle({
      drain: () => new Promise(() => {}), onStart() {}, timeoutMs: ${TEST_DRAIN_TIMEOUT_MS},
      log: console, errorId: () => ${JSON.stringify(KEYED_ERROR_ID)},
      exit: (code) => process.exit(code), setExitCode: (code) => { process.exitCode = code; },
    });
    lifecycle.fatal('unhandledRejection', new Error('synthetic fatal failure'));
    console.log(${JSON.stringify(FAILURE_STATUS_LABEL)}, process.exitCode);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
    encoding: 'utf8', timeout: CHILD_TIMEOUT_MS,
  });
  const output = child.stdout + child.stderr;
  assert.equal(child.error, undefined, output);
  assert.equal(child.signal, null, output);
  assert.equal(child.status, 1, output);
  assert.match(output, /failure-status 1/);
  assert.match(output, /drain timed out/);
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
