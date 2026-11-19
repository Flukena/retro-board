import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_RELAY_PORT } from '../src/server/public-wall-config.js';
import {
  BASELINE, assertPortsFree, checkCommand, checkEnv, entryPorts, judgeRun, parseManifest, portsFor, runWithHardTimeout,
  serverPlan, startServers, summarizeRun,
} from './live-check-common.mjs';

// Bounds for tests that spawn processes, so a broken runner fails the test instead of hanging the gate.
const SPAWN_TEST_TIMEOUT_MS = 15_000;
const HARD_TIMEOUT_SEC = 1;
const HARD_TIMEOUT_ELAPSED_LIMIT_MS = 5_000;
const READY_TIMEOUT_MS = 2_000;
const GONE_POLL_INTERVAL_MS = 50;
const GONE_POLL_LIMIT = 40;
const SLEEP_FOR_MINUTE = 'setTimeout(() => {}, 60000)';
const IPV6_LOOPBACK = '::1';
const MAINTAINER_KEY_BYTES = 32;
// Design §7.5 / task-1 brief: vite 5301+i, relay 1301+i, oidc 4401+i, maintainer 1351+i.
const FIRST_VITE_PORT = 5301;
// pan-live-check.mjs asserts its own fixed Vite port.
const PAN_VITE_PORT = 5188;
// A perl path that cannot exist, standing in for a host without perl.
const MISSING_PERL_PATH = '/nonexistent-live-check-dir/perl';
const READY_LINE = 'ready';
const KEEP_ALIVE_MS = 60_000;
// Errors a ::1 listen gives on a host without IPv6 loopback; anything else is a real failure.
const NO_IPV6_CODES = Object.freeze(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

const spawnTest = { timeout: SPAWN_TEST_TIMEOUT_MS };

const entryOf = (overrides = {}) => ({
  id: 'ui', script: 'scripts/ui-live-check.mjs', args: ['--base-url', '{base}', '--out', '{out}'], stack: 'plain',
  viteHost: '127.0.0.1', ports: {}, publicRelay: false, maintainer: false, relayEnv: {}, checkEnv: {},
  timeoutSec: 900, baseline: BASELINE.UNRUN, ...overrides,
});
const manifestOf = (...entries) => ({ entries });
const attempt = (passed, failedStep = null) => ({ passed, passLines: passed ? 1 : 0, failLines: passed ? 0 : 1, failedStep });

function listen(host, port = 0) {
  const server = createServer((socket) => socket.end());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

const portOf = (server) => server.address().port;
const close = (server) => new Promise((resolve) => { server.close(() => resolve()); });

async function freePort() {
  const server = await listen('127.0.0.1');
  const port = portOf(server);
  await close(server);
  return port;
}

const accepts = (port, host) => new Promise((resolve) => {
  const socket = connect({ port, host });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

async function hostHasIpv6Loopback() {
  try {
    await close(await listen(IPV6_LOOPBACK));
    return true;
  } catch (error) {
    if (NO_IPV6_CODES.includes(error.code)) return false;
    throw error;
  }
}
const NO_IPV6_LOOPBACK_REASON = 'this host has no IPv6 loopback (::1), so no ::1 listener can exist';
const ipv6Skip = (await hostHasIpv6Loopback()) ? false : NO_IPV6_LOOPBACK_REASON;

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

async function waitUntilGone(pid) {
  for (let poll = 0; poll < GONE_POLL_LIMIT && isAlive(pid); poll += 1) {
    await new Promise((resolve) => { setTimeout(resolve, GONE_POLL_INTERVAL_MS); });
  }
}

test('manifest rejects a known-red, env-skip or flaky entry without its reason', () => {
  const complete = {
    [BASELINE.KNOWN_RED]: { failingStep: 'A creates board, B joins' },
    [BASELINE.ENV_SKIP]: {},
    [BASELINE.FLAKY]: { observedFailRate: 0.2 },
  };
  for (const [baseline, fields] of Object.entries(complete)) {
    assert.throws(() => parseManifest(manifestOf(entryOf({ baseline, ...fields }))), /entry "ui".*reason/, baseline);
    assert.doesNotThrow(() => parseManifest(manifestOf(entryOf({ baseline, ...fields, reason: 'recorded in task 2' }))), baseline);
  }
});

test('a known-red entry needs failingStep', () => {
  const knownRed = entryOf({ baseline: BASELINE.KNOWN_RED, reason: 'red on main' });
  assert.throws(() => parseManifest(manifestOf(knownRed)), /entry "ui".*failingStep/);
  assert.throws(() => parseManifest(manifestOf({ ...knownRed, failingStep: '' })), /entry "ui".*failingStep/);
  // A script without `FAIL <step>` lines records its known red as null.
  assert.doesNotThrow(() => parseManifest(manifestOf({ ...knownRed, failingStep: null })));
});

test('a flaky entry needs observedFailRate', () => {
  const flaky = entryOf({ baseline: BASELINE.FLAKY, reason: 'intermittent on main' });
  assert.throws(() => parseManifest(manifestOf(flaky)), /entry "ui".*observedFailRate/);
});

test('duplicate ids are rejected', () => {
  assert.throws(() => parseManifest(manifestOf(entryOf(), entryOf())), /entry "ui".*duplicate/);
});

test('an entry whose script file is missing is rejected', () => {
  const missing = entryOf({ script: 'scripts/no-such-live-check.mjs' });
  assert.throws(() => parseManifest(manifestOf(missing)), /entry "ui".*scripts\/no-such-live-check\.mjs/);
});

test('the committed manifest decodes', () => {
  const manifest = parseManifest(JSON.parse(readFileSync(new URL('./live-check-manifest.json', import.meta.url), 'utf8')));
  assert.ok(manifest.entries.length > 0);
});

// The 22 live checks the design (§7.5) and task 1 + 1b.1-1b.5 list; the baseline manifest must cover each exactly once.
const LIVE_CHECK_IDS = Object.freeze([
  'ui', 'facilitation', 'retro-outcomes', 'board-reactions', 'writing-timer', 'poker', 'landing', 'modal', 'mobile',
  'spacing', 'pan', 'public-tools', 'room-lock', 'account', 'room-management', 'board-reactions-locked',
  'writing-timer-locked', 'board-drag-peer', 'board-resize', 'board-undo-middrag', 'presence', 'board-import-ui',
]);
const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const committedManifestJson = () => JSON.parse(readFileSync(new URL('./live-check-manifest.json', import.meta.url), 'utf8'));

test('the committed manifest has no unrun entry', () => {
  assert.doesNotThrow(() => parseManifest(committedManifestJson(), { requireRun: true }));
});

test("every committed entry's script exists", () => {
  for (const entry of committedManifestJson().entries) {
    assert.ok(existsSync(join(PROJECT_DIR, entry.script)), `${entry.id}: ${entry.script}`);
  }
});

test('the manifest lists all 22 live checks', () => {
  const ids = committedManifestJson().entries.map((entry) => entry.id);
  assert.equal(ids.length, LIVE_CHECK_IDS.length);
  assert.deepEqual([...ids].sort(), [...LIVE_CHECK_IDS].sort());
});

test('requireRun rejects any entry still unrun', () => {
  const manifest = manifestOf(entryOf({ baseline: BASELINE.PASS }), entryOf({ id: 'landing', baseline: BASELINE.UNRUN }));
  assert.throws(() => parseManifest(manifest, { requireRun: true }), /entry "landing".*unrun/);
  assert.equal(parseManifest(manifest).entries.length, 2);
});

test('serverPlan puts the public relay on 1235 and gives every other service its own port', () => {
  const entry = entryOf({ stack: 'oidc', viteHost: 'localhost', publicRelay: true, maintainer: true });
  const index = 4;
  const ports = portsFor(entry, index);
  const plan = serverPlan(entry, ports, '/out', { maintainerKey: randomBytes(MAINTAINER_KEY_BYTES).toString('base64url') });
  const service = (name) => plan.find((candidate) => candidate.name === name);
  // vite.config.js proxies the Public Wall to PUBLIC_RELAY_PORT; no other port reaches it.
  assert.equal(service('public-relay').port, PUBLIC_RELAY_PORT);
  assert.equal(service('vite').port, FIRST_VITE_PORT + index);
  const used = [...plan.map((candidate) => candidate.port), Number(service('relay').env.YJS_MAINTAINER_PORT)];
  assert.equal(new Set(used).size, used.length, `ports overlap: ${used}`);
  assert.equal(service('relay').env.YJS_PORT, String(service('relay').port));
  assert.equal(service('vite').env.VITE_YJS_PORT, String(service('relay').port));
  assert.equal(service('oidc').env.FAKE_OIDC_PORT, String(service('oidc').port));
  assert.equal(service('relay').env.GOOGLE_OAUTH_ENDPOINT_BASE, `http://127.0.0.1:${service('oidc').port}`);
  const pan = entryOf({ id: 'pan', ports: { vite: PAN_VITE_PORT } });
  const panPlan = serverPlan(pan, portsFor(pan, index), '/out');
  assert.equal(panPlan.find((candidate) => candidate.name === 'vite').port, PAN_VITE_PORT);
});

test('serverPlan leaves the stub to a check that runs it (oidcInCheck) but still points the relay at its port', () => {
  const entry = entryOf({ id: 'room-management', stack: 'oidc', viteHost: 'localhost', oidcInCheck: true,
    checkEnv: { FAKE_OIDC_PORT: '{oidcPort}' } });
  const ports = portsFor(entry, 0);
  const plan = serverPlan(entry, ports, '/out');
  assert.deepEqual(plan.map((service) => service.name), ['relay', 'vite']);
  const relay = plan.find((service) => service.name === 'relay');
  assert.equal(relay.env.GOOGLE_OAUTH_ENDPOINT_BASE, `http://127.0.0.1:${ports.oidc}`);
  assert.equal(checkEnv(entry, ports).FAKE_OIDC_PORT, String(ports.oidc));
  assert.ok(entryPorts(entry, ports).includes(ports.oidc), 'the check binds the stub port, so it must be free first');
  const stubbed = serverPlan({ ...entry, oidcInCheck: false }, ports, '/out');
  assert.equal(stubbed.find((service) => service.name === 'oidc').port, ports.oidc);
  assert.throws(() => parseManifest(manifestOf({ ...entry, oidcInCheck: 'yes' })), /entry "room-management".*oidcInCheck/);
});

test('serverPlan never puts the maintainer key in argv', () => {
  const entry = entryOf({ id: 'account', stack: 'oidc', viteHost: 'localhost', maintainer: true });
  const ports = portsFor(entry, 0);
  const maintainerKey = randomBytes(MAINTAINER_KEY_BYTES).toString('base64url');
  const plan = serverPlan(entry, ports, '/out', { maintainerKey });
  for (const service of plan) assert.ok(!service.args.join(' ').includes(maintainerKey), service.name);
  assert.ok(!checkCommand(entry, ports, '/out').join(' ').includes(maintainerKey));
  assert.equal(plan.find((service) => service.name === 'relay').env.YJS_MAINTAINER_KEY, maintainerKey);
  assert.equal(checkEnv(entry, ports, { maintainerKey }).YJS_MAINTAINER_KEY, maintainerKey);
});

test('checkCommand substitutes {base} and {out}', () => {
  const entry = entryOf();
  assert.deepEqual(checkCommand(entry, portsFor(entry, 0), '/data/run-1'),
    ['scripts/ui-live-check.mjs', '--base-url', `http://127.0.0.1:${FIRST_VITE_PORT}`, '--out', '/data/run-1']);
});

test('assertPortsFree rejects a port held by a foreign listener and leaves that listener open', async () => {
  const foreign = await listen('127.0.0.1');
  const port = portOf(foreign);
  try {
    await assert.rejects(assertPortsFree([port]), new RegExp(`port ${port} is held by another process`));
    assert.equal(await accepts(port, '127.0.0.1'), true);
  } finally {
    await close(foreign);
  }
});

test('assertPortsFree rejects a ::1-only listener', { skip: ipv6Skip }, async () => {
  const foreign = await listen(IPV6_LOOPBACK);
  const port = portOf(foreign);
  try {
    await assert.rejects(assertPortsFree([port]), new RegExp(`port ${port} is held by another process`));
  } finally {
    await close(foreign);
  }
});

test('assertPortsFree rejects a dual-stack listener on ::', { skip: ipv6Skip }, async () => {
  const foreign = await listen('::');
  const port = portOf(foreign);
  try {
    await assert.rejects(assertPortsFree([port]), new RegExp(`port ${port} is held by another process`));
  } finally {
    await close(foreign);
  }
});

// Spawned test processes write their pid to a file first, so a test still ends them when the code under test fails.
const SERVER_NAME = 'server';
const LEFTOVER_PID_FILES = Object.freeze([`${SERVER_NAME}.log`, 'grandchild.pid']);
const httpServerPlan = (port, host) => [{
  name: SERVER_NAME, command: process.execPath,
  args: ['-e', `console.log(process.pid); require('node:http').createServer().listen(${port}, '${host}')`],
  env: {}, port, host,
}];

/** The pid a spawned test process wrote to `path`, or NaN when it never wrote one. */
async function pidFrom(path) {
  try {
    return Number.parseInt(await readFile(path, 'utf8'), 10);
  } catch (error) {
    if (error.code === 'ENOENT') return Number.NaN;
    throw error;
  }
}

async function killLeftovers(dir) {
  for (const name of LEFTOVER_PID_FILES) {
    const pid = await pidFrom(join(dir, name));
    if (Number.isInteger(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
}

async function withTempDir(action) {
  const dir = await mkdtemp(join(tmpdir(), 'live-check-common-'));
  try {
    return await action(dir);
  } finally {
    await killLeftovers(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

test('startServers waits on the entry\'s own host', { ...spawnTest, skip: ipv6Skip }, async () => {
  await withTempDir(async (dir) => {
    const port = await freePort();
    const servers = await startServers(httpServerPlan(port, IPV6_LOOPBACK), dir, { readyTimeoutMs: READY_TIMEOUT_MS });
    try {
      assert.equal(await accepts(port, IPV6_LOOPBACK), true);
    } finally {
      await servers.stop();
    }
  });
});

test('stop() kills the process group it started and frees the port', spawnTest, async () => {
  await withTempDir(async (dir) => {
    const port = await freePort();
    const servers = await startServers(httpServerPlan(port, '127.0.0.1'), dir, { readyTimeoutMs: READY_TIMEOUT_MS });
    await servers.stop();
    await assertPortsFree([port]);
  });
});

/** A child that holds startServers' servers until the runner's shutdown wiring aborts, then stops them and exits. */
function runnerStandIn(plan, dir) {
  const imports = {
    runner: new URL('./live-check-all.mjs', import.meta.url).href,
    common: new URL('./live-check-common.mjs', import.meta.url).href,
  };
  const source = `import { abortOnShutdownSignals } from ${JSON.stringify(imports.runner)};
import { startServers } from ${JSON.stringify(imports.common)};
const keepAlive = setInterval(() => {}, ${KEEP_ALIVE_MS});
const controller = abortOnShutdownSignals();
const servers = await startServers(${JSON.stringify(plan)}, ${JSON.stringify(dir)}, { readyTimeoutMs: ${READY_TIMEOUT_MS} });
controller.signal.addEventListener('abort', async () => { await servers.stop(); clearInterval(keepAlive); }, { once: true });
console.log(${JSON.stringify(READY_LINE)});`;
  return spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
}

async function untilLine(stream, line) {
  stream.setEncoding('utf8');
  let seen = '';
  for await (const chunk of stream) {
    seen += chunk;
    if (seen.split('\n').includes(line)) return;
  }
  throw new Error(`stream ended before "${line}"`);
}

// The live-check constraints bound every run with `perl -e 'alarm N; exec @ARGV'`, whose SIGALRM reaches the runner.
for (const signal of ['SIGTERM', 'SIGALRM']) {
  test(`${signal} to the runner stops the servers it started`, spawnTest, async () => {
    await withTempDir(async (dir) => {
      const port = await freePort();
      const child = runnerStandIn(httpServerPlan(port, '127.0.0.1'), dir);
      const exited = once(child, 'exit');
      try {
        await untilLine(child.stdout, READY_LINE);
        child.kill(signal);
        const [code, killedBy] = await exited;
        assert.deepEqual({ code, killedBy }, { code: 0, killedBy: null }, 'the runner exits on its own after cleanup');
        await assertPortsFree([port]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
  });
}

test('runWithHardTimeout kills a sleeping child after timeoutSec', spawnTest, async () => {
  const started = Date.now();
  const result = await runWithHardTimeout([process.execPath, '-e', SLEEP_FOR_MINUTE], { timeoutSec: HARD_TIMEOUT_SEC });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(Date.now() - started < HARD_TIMEOUT_ELAPSED_LIMIT_MS, `took ${Date.now() - started} ms`);
});

test('runWithHardTimeout kills a grandchild too', spawnTest, async () => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, 'grandchild.pid');
    const parent = `const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP_FOR_MINUTE)}], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
${SLEEP_FOR_MINUTE};`;
    const result = await runWithHardTimeout([process.execPath, '-e', parent], { timeoutSec: HARD_TIMEOUT_SEC });
    const grandchildPid = await pidFrom(pidFile);
    assert.ok(Number.isInteger(grandchildPid), 'the check never started its grandchild');
    assert.equal(result.timedOut, true);
    await waitUntilGone(grandchildPid);
    assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
  });
});

test('runWithHardTimeout keeps a Thai step name intact when it arrives split across chunks', spawnTest, async () => {
  // Thai step names (B's language) are 3 bytes per character in UTF-8; split the first character between two writes.
  const step = 'PASS ไทย';
  const writer = `const bytes = Buffer.from(${JSON.stringify(step)});
process.stdout.write(bytes.subarray(0, 6));
setTimeout(() => process.stdout.write(bytes.subarray(6)), 100);`;
  const result = await runWithHardTimeout([process.execPath, '-e', writer], { timeoutSec: HARD_TIMEOUT_SEC });
  assert.equal(result.stdout, step);
});

test('runWithHardTimeout reports a missing perl', spawnTest, async () => {
  await assert.rejects(
    runWithHardTimeout([process.execPath, '-e', ''], { timeoutSec: HARD_TIMEOUT_SEC, perlPath: MISSING_PERL_PATH }),
    /perl is required for the live-check hard timeout/,
  );
});

test('runWithHardTimeout finds perl without searching PATH', spawnTest, async () => {
  const result = await runWithHardTimeout([process.execPath, '-e', 'console.log("ran")'],
    { timeoutSec: HARD_TIMEOUT_SEC, env: { PATH: '/nonexistent-live-check-dir' } });
  assert.deepEqual({ exitCode: result.exitCode, stdout: result.stdout }, { exitCode: 0, stdout: 'ran\n' });
});

test('summarizeRun counts PASS and FAIL lines and names the first failing step', () => {
  // runLiveCheck prints one `PASS <step>` or `FAIL <step>` line per step after the run.
  const stdout = ['{"result":"PASS"}', 'PASS A creates board, B joins', 'PASS en: sticky syncs', 'FAIL th: undo reaches A',
    'FAIL plain: no page errors', ''].join('\n');
  assert.deepEqual(summarizeRun(stdout, 1),
    { passed: false, passLines: 2, failLines: 2, failedStep: 'th: undo reaches A' });
  assert.deepEqual(summarizeRun('PASS only step\n', 0), { passed: true, passLines: 1, failLines: 0, failedStep: null });
  assert.equal(summarizeRun('PASS only step\n', null).passed, false, 'a killed check did not pass');
  assert.equal(summarizeRun('FAIL x\n', 0).passed, false, 'a FAIL line fails the run even when the check exits 0');
});

test('judgeRun: pass entry that fails once is a regression', () => {
  const entry = entryOf({ baseline: BASELINE.PASS });
  assert.equal(judgeRun(entry, [attempt(true), attempt(false, 'B joins')]), 'regression');
  assert.equal(judgeRun(entry, [attempt(true), attempt(true)]), 'ok');
});

test('judgeRun: a pass entry whose check exits 1 or times out without a FAIL line is a regression', () => {
  const entry = entryOf({ baseline: BASELINE.PASS });
  assert.equal(judgeRun(entry, [summarizeRun('PASS A creates board, B joins\n', 1)]), 'regression');
  assert.equal(judgeRun(entry, [summarizeRun('PASS A creates board, B joins\n', null)]), 'regression');
});

test('judgeRun: a known-red entry recorded with failingStep null is ok only for a failure without a FAIL line', () => {
  const noStepLines = entryOf({ id: 'mobile', baseline: BASELINE.KNOWN_RED, reason: 'red on main', failingStep: null });
  assert.equal(judgeRun(noStepLines, [summarizeRun('PASS desktop pinch\n', 1)]), 'ok');
  assert.equal(judgeRun(noStepLines, [summarizeRun('FAIL th: undo reaches A\n', 1)]), 'regression');
  const named = entryOf({ baseline: BASELINE.KNOWN_RED, reason: 'red on main', failingStep: 'th: undo reaches A' });
  assert.equal(judgeRun(named, [summarizeRun('PASS A creates board, B joins\n', 1)]), 'regression');
});

test('judgeRun: known-red failing at its recorded failingStep is ok, at another step is a regression, passing is improved', () => {
  const entry = entryOf({ baseline: BASELINE.KNOWN_RED, reason: 'red on main', failingStep: 'th: undo reaches A' });
  assert.equal(judgeRun(entry, [attempt(false, 'th: undo reaches A')]), 'ok');
  assert.equal(judgeRun(entry, [attempt(false, 'A creates board, B joins')]), 'regression');
  assert.equal(judgeRun(entry, [attempt(true)]), 'improved');
});

test('judgeRun: flaky entry fails only when all three attempts fail', () => {
  const entry = entryOf({ baseline: BASELINE.FLAKY, reason: 'intermittent', observedFailRate: 0.3 });
  assert.equal(judgeRun(entry, [attempt(false, 'x'), attempt(false, 'x'), attempt(true)]), 'ok');
  assert.equal(judgeRun(entry, [attempt(false, 'x'), attempt(false, 'x'), attempt(false, 'x')]), 'regression');
});

test('judgeRun: env-skip is skipped', () => {
  const entry = entryOf({ baseline: BASELINE.ENV_SKIP, reason: 'cannot run on this Mac' });
  assert.equal(judgeRun(entry, []), 'skipped');
});
