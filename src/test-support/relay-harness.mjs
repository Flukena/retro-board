import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const START_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 3_000;
const LISTENING_RE = /listening on ws:\/\/127\.0\.0\.1:(\d+)/;
// node:test runs t.after hooks first-in-first-out, so a root's removal stops its test's relays itself.
const stopsByTest = new WeakMap();
const stopsOf = (t) => {
  if (!stopsByTest.has(t)) stopsByTest.set(t, []);
  return stopsByTest.get(t);
};

/** A temp directory removed after the test; pass it as `root` to restart a relay on the same data. */
export async function tempRoot(t, prefix = 'relay-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await Promise.all(stopsOf(t).map((stop) => stop()));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

/**
 * Spawns the real yjs-server.mjs on a free port with its DB and uploads under `root`
 * (a fresh temp dir by default). It is stopped with SIGTERM after the test.
 */
export async function startRelay(t, env = {}, { preload = null, root = null } = {}) {
  const dir = root ?? await tempRoot(t);
  const args = preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'yjs-server.mjs'] : ['yjs-server.mjs'];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env, YJS_PORT: '0', YJS_HOST: '127.0.0.1', YJS_DB_DIR: join(dir, 'db'), YJS_UPLOADS_DIR: join(dir, 'uploads'),
      YJS_WIPE_DOCS: '', YJS_MIGRATE_DOCS: '', YJS_ALLOW_LEGACY_ROOMS: '0', YJS_ALLOW_LEGACY_URL_TOKENS: '0', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, at: Date.now() })));
  const stop = async (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    const killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_TIMEOUT_MS);
    child.kill(signal);
    const result = await exited;
    clearTimeout(killTimer);
    return result;
  };
  stopsOf(t).push(stop);
  t.after(() => stop());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay start timed out\n${output}`)), START_TIMEOUT_MS);
    const inspect = () => {
      const match = output.match(LISTENING_RE);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on('data', inspect);
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`relay exited ${code}\n${output}`)); });
  });
  return {
    url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, root: dir, dbDir: join(dir, 'db'),
    child, exited, stop, output: () => output,
  };
}

const get = (url, headers = {}) => fetch(url, { headers, redirect: 'manual' });

/** Start → stub consent → the callback URL and flow cookie the browser would carry back. */
export async function approvedCallback(relay, stub, prefix, returnTo) {
  const start = await get(`${relay.url}${prefix}/api/auth/google/start?return=${encodeURIComponent(returnTo)}`);
  assert.equal(start.status, 302, relay.output());
  const flowCookie = start.headers.getSetCookie()[0];
  const consent = await get(`${stub.url}/auth${new URL(start.headers.get('location')).search}&decision=approve`);
  assert.equal(consent.status, 302);
  return { flowCookie, url: `${relay.url}${prefix}/api/auth/google/callback${new URL(consent.headers.get('location')).search}` };
}
