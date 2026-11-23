// Local live-check server lifecycle, loopback probes and child-process timeouts.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { PROJECT_ROOT } from './project-files.mjs';

export const LOOPBACK_V4 = '127.0.0.1';
export const LOCALHOST = 'localhost';
const LOOPBACK_HOSTS = Object.freeze([LOOPBACK_V4, '::1']);

export const DEFAULT_CHECK_TIMEOUT_SEC = 900;
// A cold Vite start (dependency pre-bundling) is the slowest service.
const SERVER_READY_TIMEOUT_MS = 60_000;
const SERVER_STOP_GRACE_MS = 5_000;
const READY_POLL_INTERVAL_MS = 200;
const PORT_PROBE_TIMEOUT_MS = 1_000;
const GROUP_EXIT_POLL_INTERVAL_MS = 50;
const MS_PER_SECOND = 1_000;
// The perl alarm is only a backstop behind the JavaScript timer and its SIGTERM/SIGKILL grace.
const PERL_ALARM_MARGIN_SEC = 10;
// An absolute path, so no PATH lookup can pick another perl (Sonar S4036); present on macOS and ubuntu-latest.
const PERL_PATH = '/usr/bin/perl';
const PERL_ALARM_EXEC = 'alarm shift; exec @ARGV';
const PERL_MISSING = 'perl is required for the live-check hard timeout';

/** A port answered a TCP connect, so a process this runner did not start holds it. */
export class PortHeldError extends Error {
  constructor(port) {
    super(`port ${port} is held by another process`);
    this.name = 'PortHeldError';
    this.port = port;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Whether something accepts a TCP connect on host:port; the probe socket is closed at once. */
function answers(port, host) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const settle = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

const anyAnswers = async (port, hosts) => (await Promise.all(hosts.map((host) => answers(port, host)))).some(Boolean);

/** Rejects with PortHeldError for the first port that answers on 127.0.0.1 or ::1; never signals the holder. */
export async function assertPortsFree(ports) {
  for (const port of ports) {
    if (await anyAnswers(port, LOOPBACK_HOSTS)) throw new PortHeldError(port);
  }
}

const GROUP_GONE = 'ESRCH';
// macOS answers EPERM for a group whose remaining members are already exiting (zombies awaiting their reaper).
const GROUP_EXITING = 'EPERM';

/** Signals every process in the group led by `pid`, a detached child of this runner; no pid (spawn failed) is a no-op. */
function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // An exiting group needs no signal; awaitGroupGone still confirms that it disappears.
    if (![GROUP_GONE, GROUP_EXITING].includes(error.code)) throw error;
  }
}

/** Whether any member of the group is left, exiting ones included. */
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === GROUP_GONE) return false;
    if (error.code === GROUP_EXITING) return true;
    throw error;
  }
}

/** Waits until no process of the group led by `pid` is left; a group that outlives `timeoutMs` is an error. */
async function awaitGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pid && groupAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`process group ${pid} survived SIGKILL`);
    await sleep(GROUP_EXIT_POLL_INTERVAL_MS);
  }
}

/** Kills the group led by `pid` and waits until it is gone, leaving SIGTERM's grace to a caller that wants one. */
async function killGroup(pid) {
  signalGroup(pid, 'SIGKILL');
  await awaitGroupGone(pid, SERVER_STOP_GRACE_MS);
}

function spawnService(service, outDir) {
  const log = openSync(join(outDir, `${service.name}.log`), 'w');
  try {
    const child = spawn(service.command, service.args, {
      cwd: PROJECT_ROOT, env: { ...process.env, ...service.env }, detached: true, stdio: ['ignore', log, log],
    });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (error) => resolve({ code: null, signal: null, error }));
    });
    return { ...service, child, exited };
  } finally {
    closeSync(log);
  }
}

async function waitUntilReady(started, timeoutMs) {
  const hosts = started.host === LOCALHOST ? LOOPBACK_HOSTS : [started.host];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await anyAnswers(started.port, hosts)) return;
    const exit = await Promise.race([started.exited, sleep(READY_POLL_INTERVAL_MS).then(() => null)]);
    if (exit) {
      const how = exit.error?.message ?? exit.code ?? exit.signal;
      throw new Error(`${started.name} exited (${how}) before port ${started.port} answered; see ${started.name}.log`);
    }
  }
  throw new Error(`${started.name} did not answer on ${started.host}:${started.port} within ${timeoutMs} ms`);
}

async function stopService({ child, exited }) {
  signalGroup(child.pid, 'SIGTERM');
  const graceful = await Promise.race([exited, sleep(SERVER_STOP_GRACE_MS).then(() => null)]);
  signalGroup(child.pid, 'SIGKILL');
  if (!graceful) await exited;
  await awaitGroupGone(child.pid, SERVER_STOP_GRACE_MS);
}

/** Stops every started service, newest first, even when one of them fails to stop; then reports the first failure. */
async function stopAll(started) {
  const results = [];
  while (started.length) results.push(...await Promise.allSettled([stopService(started.pop())]));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * Starts each planned service in its own process group, logging to `<outDir>/<name>.log` (truncated per run and
 * bounded by the run's hard timeout; kept on the data volume, a deliberate exception to log rotation), and waits
 * until its port accepts a connect on its own host. `stop()` ends only the groups started here and awaits their exit.
 */
export async function startServers(plan, outDir, { readyTimeoutMs = SERVER_READY_TIMEOUT_MS } = {}) {
  const started = [];
  const stop = () => stopAll(started);
  try {
    for (const service of plan) {
      started.push(spawnService(service, outDir));
      await waitUntilReady(started.at(-1), readyTimeoutMs);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}

function spawnUnderAlarm(argv, { timeoutSec, env, cwd, perlPath }) {
  return spawn(perlPath, ['-e', PERL_ALARM_EXEC, String(timeoutSec + PERL_ALARM_MARGIN_SEC), ...argv], {
    cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collectOutput(child) {
  const output = { stdout: '', stderr: '' };
  // Decoding per stream keeps a multi-byte character (Thai step names) intact across chunk boundaries.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  return output;
}

/** SIGTERM to the group now and SIGKILL after the grace; `cancel()` drops the pending SIGKILL. */
function groupTerminator(child) {
  let killTimer;
  return {
    terminate() {
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), SERVER_STOP_GRACE_MS);
    },
    cancel() { clearTimeout(killTimer); },
  };
}

/** Calls `onAbort` once when `signal` aborts (at once if it already has); returns the unsubscribe. */
function onAbort(signal, action) {
  if (!signal) return () => {};
  if (signal.aborted) action();
  else signal.addEventListener('abort', action, { once: true });
  return () => signal.removeEventListener('abort', action);
}

/**
 * Runs `argv` in its own process group under a hard timeout: SIGTERM to the whole group at `timeoutSec` (or when
 * `signal` aborts), SIGKILL after the grace, and a perl alarm as a backstop. Any process left in that group is killed
 * before this resolves. Playwright starts Chromium in a group of its own and closes it on SIGTERM (its default
 * `handleSIGTERM`), so the grace is what keeps a second Chromium from meeting the next check. `env` is added to the
 * runner's; `perlPath` exists so a test can point at a missing perl.
 */
export function runWithHardTimeout(argv, {
  timeoutSec = DEFAULT_CHECK_TIMEOUT_SEC, env = {}, cwd = PROJECT_ROOT, signal, perlPath = PERL_PATH,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnUnderAlarm(argv, { timeoutSec, env, cwd, perlPath });
    const output = collectOutput(child);
    const terminator = groupTerminator(child);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; terminator.terminate(); }, timeoutSec * MS_PER_SECOND);
    const unsubscribe = onAbort(signal, terminator.terminate);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error.code === 'ENOENT' ? new Error(PERL_MISSING) : error);
    });
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timeout);
      terminator.cancel();
      unsubscribe();
      killGroup(child.pid)
        .then(() => resolve({ exitCode, signal: exitSignal, timedOut: timedOut || exitSignal === 'SIGALRM', ...output }))
        .catch(reject);
    });
  });
}
