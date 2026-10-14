import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHILD_TIMEOUT_MS = 3_000;
const TEST_SESSION_SECRET = 'relay-resilience-test-secret-00000000';
const PRIVATE_ERROR_MESSAGE = 'raw-room-token-must-stay-private';
const NULL_PROTOTYPE_REJECTION_SOURCE = 'Object.create(null)';
const THROWING_COERCION_REJECTION_SOURCE = `({ toString() { throw new Error('${PRIVATE_ERROR_MESSAGE}'); } })`;

const runRelay = (root, preload, overrides = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`, process.env.RB_TEST_RELAY_ENTRY || 'yjs-server.mjs',
  ], {
    env: {
      ...process.env, YJS_PORT: '0', YJS_HOST: '127.0.0.1',
      YJS_DB_DIR: join(root, 'db'), YJS_UPLOADS_DIR: join(root, 'images'),
      YJS_SESSION_SECRET: TEST_SESSION_SECRET,
      YJS_WIPE_DOCS: '', YJS_MIGRATE_DOCS: '', ...overrides,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => { output += chunk; };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const timeout = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  child.once('error', (err) => { clearTimeout(timeout); reject(err); });
  child.once('close', (code, signal) => {
    clearTimeout(timeout);
    resolve({ code, signal, output });
  });
});

const fatalPreload = (event, rejectionSource = `new Error('${PRIVATE_ERROR_MESSAGE}')`) => `
  import { Server } from 'node:http';
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (...args) {
    this.once('listening', () => setImmediate(() => {
      ${event === 'unhandledRejection'
        ? `Promise.reject(${rejectionSource});`
        : `throw new Error('${PRIVATE_ERROR_MESSAGE}');`}
    }));
    return listen.apply(this, args);
  };
`;

for (const event of ['unhandledRejection', 'uncaughtException']) {
  test(`${event} drains a real relay and exits non-zero without logging private error content`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-fatal-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await runRelay(root, fatalPreload(event));
    assert.equal(result.code, 1, result.output);
    assert.equal(result.signal, null, result.output);
    assert.match(result.output, /\[yjs\] drained/);
    assert.equal((result.output.match(/\[yjs\] draining/g) || []).length, 1);
    assert.equal(result.output.includes(PRIVATE_ERROR_MESSAGE), false);
  });
}

for (const [name, rejectionSource] of [
  ['null prototype', NULL_PROTOTYPE_REJECTION_SOURCE],
  ['throwing toString', THROWING_COERCION_REJECTION_SOURCE],
]) {
  test(`non-Error rejection (${name}) drains a real relay without leaking coercion failures`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-non-error-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await runRelay(root, fatalPreload('unhandledRejection', rejectionSource));
    assert.equal(result.code, 1, result.output);
    assert.equal(result.signal, null, result.output);
    assert.match(result.output, /\[yjs\] drained/);
    assert.match(result.output, /\[yjs\] fatal process error/);
    assert.match(result.output, /reason: 'unhandledRejection'/);
    assert.equal((result.output.match(/\[yjs\] draining/g) || []).length, 1);
    assert.equal(result.output.includes(PRIVATE_ERROR_MESSAGE), false);
  });
}

test('database quota storage latch drains the real relay and exits for restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runRelay(root, '', { YJS_MAX_DB_BYTES: '1' });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.signal, null, result.output);
  assert.match(result.output, /storage degraded/);
  assert.match(result.output, /\[yjs\] drained/);
  assert.equal((result.output.match(/\[yjs\] draining/g) || []).length, 1);
});
