import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPortsFree, runWithHardTimeout, startServers } from './live-check-process.mjs';

// Bounds for tests that spawn processes, so a broken runner fails the test instead of hanging the gate.
const SPAWN_TEST_TIMEOUT_MS = 15_000;
const HARD_TIMEOUT_SEC = 1;
const HARD_TIMEOUT_ELAPSED_LIMIT_MS = 5_000;
const READY_TIMEOUT_MS = 2_000;
const GONE_POLL_INTERVAL_MS = 50;
const GONE_POLL_LIMIT = 40;
const SLEEP_FOR_MINUTE = 'setTimeout(() => {}, 60000)';
const IPV6_LOOPBACK = '::1';
// A perl path that cannot exist, standing in for a host without perl.
const MISSING_PERL_PATH = '/nonexistent-live-check-dir/perl';
const READY_LINE = 'ready';
const KEEP_ALIVE_MS = 60_000;
// Errors a ::1 listen gives on a host without IPv6 loopback; anything else is a real failure.
const NO_IPV6_CODES = Object.freeze(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

const spawnTest = { timeout: SPAWN_TEST_TIMEOUT_MS };

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
    processes: new URL('./live-check-process.mjs', import.meta.url).href,
  };
  const source = `import { abortOnShutdownSignals } from ${JSON.stringify(imports.runner)};
import { startServers } from ${JSON.stringify(imports.processes)};
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
