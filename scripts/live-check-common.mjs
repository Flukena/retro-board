// Shared pieces of the sequential live-check runner (live-check-all.mjs): the manifest decoder
// (scripts/live-check-manifest.json, design §7.5), each check's server recipe, port checks that never touch a
// foreign process, process-group lifecycles and the regression verdict.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { PUBLIC_RELAY_PORT } from '../src/server/public-wall-config.js';
import { PROJECT_ROOT } from './project-files.mjs';

export const BASELINE = Object.freeze({ PASS: 'pass', KNOWN_RED: 'known-red', ENV_SKIP: 'env-skip', FLAKY: 'flaky', UNRUN: 'unrun' });
export const VERDICT = Object.freeze({ OK: 'ok', IMPROVED: 'improved', REGRESSION: 'regression', SKIPPED: 'skipped' });
const STACK = Object.freeze({ PLAIN: 'plain', OIDC: 'oidc' });
const LOOPBACK_V4 = '127.0.0.1';
const LOCALHOST = 'localhost';
const VITE_HOSTS = Object.freeze([LOOPBACK_V4, LOCALHOST]);
const LOOPBACK_HOSTS = Object.freeze([LOOPBACK_V4, '::1']);

export const DEFAULT_CHECK_TIMEOUT_SEC = 900;
// A cold Vite start (dependency pre-bundling) is the slowest service.
const SERVER_READY_TIMEOUT_MS = 60_000;
const SERVER_STOP_GRACE_MS = 5_000;
export const FLAKY_ATTEMPTS = 3;
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

// Ports per manifest position (task-1 brief): index i gets base + i unless the entry fixes its Vite port.
const PORT_BASE = Object.freeze({ vite: 5301, relay: 1301, oidc: 4401, maintainer: 1351 });
// Dev fixture limits from ui-live-check.mjs's header, so repeated runs can create rooms; production keeps its own.
const ROOM_CREATE_BURST = '100';
const ROOM_CREATES_PER_HOUR = '1000';
// Placeholders the dev-only fake Google accepts (fake-google-oidc.mjs ignores the secret); not credentials.
const FAKE_OIDC_CLIENT_ID = 'dev-client';
const FAKE_OIDC_CLIENT_SECRET = 'dev-secret';
const ENV_TRUE = 'true';

const ARG_TOKENS = Object.freeze(['base', 'out']);
const CHECK_ENV_TOKENS = Object.freeze(['oidcPort', 'relayPort']);
const TOKEN_PATTERN = /\{(\w+)\}/g;
// Ids name output directories, so they stay plain slugs.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const STEP_LINE = /^(PASS|FAIL) (.+)$/;
const FAIL_WORD = 'FAIL';
// `npx vite` without the npm wrapper process or a PATH lookup.
const VITE_BIN = 'node_modules/vite/bin/vite.js';
const RELAY_SCRIPT = 'yjs-server.mjs';
const FAKE_OIDC_SCRIPT = 'scripts/fake-google-oidc.mjs';

/** A port answered a TCP connect, so a process this runner did not start holds it. */
export class PortHeldError extends Error {
  constructor(port) {
    super(`port ${port} is held by another process`);
    this.name = 'PortHeldError';
    this.port = port;
  }
}

// ---------------------------------------------------------------- manifest

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringMap = (value) => isPlainObject(value) && Object.values(value).every((item) => typeof item === 'string');
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isRate = (value) => typeof value === 'number' && value > 0 && value <= 1;
const isText = (value) => typeof value === 'string' && value.length > 0;
// null records a known-red run whose script prints no `FAIL <step>` line (see judgeKnownRed).
const isFailingStep = (value) => value === null || isText(value);

function entryError(entry, index, message) {
  return new Error(`manifest entry "${entry?.id ?? `#${index}`}": ${message}`);
}

function assertTokens(entry, index, values, allowed, field) {
  for (const value of values) {
    for (const [, token] of value.matchAll(TOKEN_PATTERN)) {
      if (!allowed.includes(token)) throw entryError(entry, index, `${field} uses unknown token {${token}}`);
    }
  }
}

function validateIdentity(entry, index, seenIds) {
  if (!isText(entry?.id) || !ID_PATTERN.test(entry.id)) throw entryError(entry, index, 'id must be a lowercase slug');
  if (seenIds.has(entry.id)) throw entryError(entry, index, 'duplicate id');
  seenIds.add(entry.id);
  if (!isText(entry.script) || !existsSync(join(PROJECT_ROOT, entry.script))) {
    throw entryError(entry, index, `script ${entry.script} does not exist`);
  }
}

function validateRecipe(entry, index) {
  const wrong = [
    [Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string'), 'args must be strings'],
    [Object.values(STACK).includes(entry.stack), `stack must be ${Object.values(STACK).join(' or ')}`],
    [VITE_HOSTS.includes(entry.viteHost), `viteHost must be ${VITE_HOSTS.join(' or ')}`],
    [isPlainObject(entry.ports) && (entry.ports.vite === undefined || isPositiveInteger(entry.ports.vite)), 'ports.vite must be a port number'],
    [typeof entry.publicRelay === 'boolean' && typeof entry.maintainer === 'boolean', 'publicRelay and maintainer are booleans'],
    [entry.oidcInCheck === undefined || typeof entry.oidcInCheck === 'boolean', 'oidcInCheck is a boolean'],
    [isStringMap(entry.relayEnv) && isStringMap(entry.checkEnv), 'relayEnv and checkEnv map names to strings'],
    [isPositiveInteger(entry.timeoutSec), 'timeoutSec must be a positive integer'],
  ].find(([valid]) => !valid);
  if (wrong) throw entryError(entry, index, wrong[1]);
  assertTokens(entry, index, entry.args, ARG_TOKENS, 'args');
  assertTokens(entry, index, Object.values(entry.checkEnv), CHECK_ENV_TOKENS, 'checkEnv');
}

function validateBaseline(entry, index, requireRun) {
  const { baseline } = entry;
  if (!Object.values(BASELINE).includes(baseline)) throw entryError(entry, index, `unknown baseline ${baseline}`);
  if (requireRun && baseline === BASELINE.UNRUN) throw entryError(entry, index, 'baseline is still unrun');
  const needsReason = [BASELINE.KNOWN_RED, BASELINE.ENV_SKIP, BASELINE.FLAKY].includes(baseline);
  if (needsReason && !isText(entry.reason)) throw entryError(entry, index, `${baseline} needs a reason`);
  if (baseline === BASELINE.KNOWN_RED && !(Object.hasOwn(entry, 'failingStep') && isFailingStep(entry.failingStep))) {
    throw entryError(entry, index, 'known-red needs failingStep (a step name, or null for a script without FAIL lines)');
  }
  if (baseline === BASELINE.FLAKY && !isRate(entry.observedFailRate)) {
    throw entryError(entry, index, 'flaky needs observedFailRate in (0, 1]');
  }
}

/** Decodes the live-check manifest; throws an Error naming the first invalid entry. */
export function parseManifest(json, { requireRun = false } = {}) {
  if (!Array.isArray(json?.entries)) throw new Error('manifest must be an object with an entries array');
  const seenIds = new Set();
  json.entries.forEach((entry, index) => {
    validateIdentity(entry, index, seenIds);
    validateRecipe(entry, index);
    validateBaseline(entry, index, requireRun);
  });
  return Object.freeze({ entries: Object.freeze(json.entries.map((entry) => Object.freeze({ ...entry }))) });
}

// ---------------------------------------------------------------- recipe

/** The ports of the entry at manifest position `index`. */
export function portsFor(entry, index) {
  return Object.freeze({
    vite: entry.ports.vite ?? PORT_BASE.vite + index,
    relay: PORT_BASE.relay + index,
    oidc: PORT_BASE.oidc + index,
    maintainer: PORT_BASE.maintainer + index,
    publicRelay: PUBLIC_RELAY_PORT,
  });
}

/** Every port a run of `entry` binds, including the ones a server opens beside its main port. */
export function entryPorts(entry, ports) {
  return [
    ports.vite, ports.relay,
    ...(entry.stack === STACK.OIDC ? [ports.oidc] : []),
    ...(entry.maintainer ? [ports.maintainer] : []),
    ...(entry.publicRelay ? [ports.publicRelay] : []),
  ];
}

const baseUrl = (entry, ports) => `http://${entry.viteHost}:${ports.vite}`;
const allowedOrigins = (ports) => VITE_HOSTS.map((host) => `http://${host}:${ports.vite}`).join(',');
const substitute = (value, values) => value.replaceAll(TOKEN_PATTERN, (token, name) => values[name] ?? token);

function oidcService(ports) {
  return {
    name: 'oidc', command: process.execPath, args: [FAKE_OIDC_SCRIPT],
    env: { FAKE_OIDC_PORT: String(ports.oidc) }, port: ports.oidc, host: LOOPBACK_V4,
  };
}

function oidcRelayEnv(entry, ports) {
  if (entry.stack !== STACK.OIDC) return {};
  return {
    GOOGLE_OAUTH_ENDPOINT_BASE: `http://${LOOPBACK_V4}:${ports.oidc}`,
    GOOGLE_OAUTH_CLIENT_ID: FAKE_OIDC_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: FAKE_OIDC_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: `http://${LOCALHOST}:${ports.relay}/api/auth/google/callback`,
  };
}

function maintainerEnv(entry, ports, { maintainerKey }) {
  if (!entry.maintainer) return {};
  if (!maintainerKey) throw new Error(`entry "${entry.id}" needs a per-run maintainer key`);
  return { YJS_MAINTAINER_KEY: maintainerKey, YJS_MAINTAINER_PORT: String(ports.maintainer) };
}

function relayService(entry, ports, outDir, secrets) {
  return {
    name: 'relay', command: process.execPath, args: [RELAY_SCRIPT], port: ports.relay, host: LOOPBACK_V4,
    env: {
      YJS_ALLOW_INSECURE_HTTP: ENV_TRUE, YJS_PORT: String(ports.relay),
      YJS_ROOM_CREATE_BURST: ROOM_CREATE_BURST, YJS_ROOM_CREATES_PER_HOUR: ROOM_CREATES_PER_HOUR,
      YJS_ALLOWED_ORIGINS: allowedOrigins(ports),
      YJS_DB_DIR: join(outDir, 'db'), YJS_UPLOADS_DIR: join(outDir, 'uploads'),
      ...oidcRelayEnv(entry, ports), ...maintainerEnv(entry, ports, secrets), ...entry.relayEnv,
    },
  };
}

function publicRelayService(ports, outDir) {
  return {
    name: 'public-relay', command: process.execPath, args: [RELAY_SCRIPT], port: ports.publicRelay, host: LOOPBACK_V4,
    env: {
      YJS_PUBLIC_WALL: ENV_TRUE, YJS_PORT: String(ports.publicRelay), YJS_DB_DIR: join(outDir, 'public-db'),
      YJS_ALLOW_INSECURE_HTTP: ENV_TRUE, YJS_ALLOWED_ORIGINS: allowedOrigins(ports),
    },
  };
}

function viteService(entry, ports) {
  return {
    name: 'vite', command: process.execPath,
    args: [VITE_BIN, '--host', entry.viteHost, '--port', String(ports.vite), '--strictPort'],
    env: { VITE_YJS_PORT: String(ports.relay) }, port: ports.vite, host: entry.viteHost,
  };
}

/**
 * The servers a run of `entry` needs, in start order; pure. `env` holds only the variables the recipe sets, and the
 * maintainer key (`secrets.maintainerKey`) is only ever placed there, never in argv.
 */
export function serverPlan(entry, ports, outDir, secrets = {}) {
  return [
    ...(entry.stack === STACK.OIDC && !entry.oidcInCheck ? [oidcService(ports)] : []),
    relayService(entry, ports, outDir, secrets),
    ...(entry.publicRelay ? [publicRelayService(ports, outDir)] : []),
    viteService(entry, ports),
  ];
}

/** The check's argv after `node`, with `{base}` and `{out}` filled in; pure. */
export function checkCommand(entry, ports, outDir) {
  const values = { base: baseUrl(entry, ports), out: outDir };
  return [entry.script, ...entry.args.map((arg) => substitute(arg, values))];
}

/** The variables the check itself needs (on top of the runner's environment); pure. */
export function checkEnv(entry, ports, secrets = {}) {
  const values = { oidcPort: String(ports.oidc), relayPort: String(ports.relay) };
  const own = Object.fromEntries(Object.entries(entry.checkEnv).map(([name, value]) => [name, substitute(value, values)]));
  return { ...own, ...maintainerEnv(entry, ports, secrets) };
}

// ---------------------------------------------------------------- ports and processes

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

// ---------------------------------------------------------------- verdict

/**
 * Reads the `PASS <step>` / `FAIL <step>` lines runLiveCheck prints. A run passes only when it exits 0 and prints no
 * FAIL line (fail-closed), so a timeout (no exit code) or a non-zero exit fails even when the script prints no FAIL.
 */
export function summarizeRun(stdout, exitCode) {
  const steps = stdout.split('\n').map((line) => STEP_LINE.exec(line.trimEnd())).filter(Boolean);
  const failed = steps.filter(([, word]) => word === FAIL_WORD);
  return {
    passed: exitCode === 0 && failed.length === 0,
    passLines: steps.length - failed.length,
    failLines: failed.length,
    failedStep: failed[0]?.[2] ?? null,
  };
}

/**
 * A failed attempt is the known red only when its first failed step equals `failingStep`. Scripts that print no
 * `FAIL <step>` line (mobile, modal, public-tools, landing, spacing, ui) fail with failedStep null, which matches
 * only a recorded `failingStep: null`.
 */
function judgeKnownRed(entry, attempts) {
  if (attempts.every((run) => run.passed)) return VERDICT.IMPROVED;
  return attempts.every((run) => run.passed || run.failedStep === entry.failingStep) ? VERDICT.OK : VERDICT.REGRESSION;
}

/**
 * Design §7.5: a `pass` entry (and an `unrun` one, judged as strictly) regresses on any failed attempt; a `flaky`
 * one only when every attempt failed; a `known-red` one when it fails at a step other than `failingStep`.
 */
export function judgeRun(entry, attempts) {
  if (entry.baseline === BASELINE.ENV_SKIP) return VERDICT.SKIPPED;
  if (!attempts.length) throw new Error(`entry "${entry.id}" has no attempts to judge`);
  if (entry.baseline === BASELINE.KNOWN_RED) return judgeKnownRed(entry, attempts);
  if (entry.baseline === BASELINE.FLAKY) return attempts.some((run) => run.passed) ? VERDICT.OK : VERDICT.REGRESSION;
  return attempts.every((run) => run.passed) ? VERDICT.OK : VERDICT.REGRESSION;
}
