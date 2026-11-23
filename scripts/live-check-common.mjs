// Manifest validation, server recipes and verdicts for the sequential live-check runner.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_RELAY_PORT } from '../src/server/public-wall-config.js';
import { LOCALHOST, LOOPBACK_V4 } from './live-check-process.mjs';
import { PROJECT_ROOT } from './project-files.mjs';

export { DEFAULT_CHECK_TIMEOUT_SEC, PortHeldError, assertPortsFree, runWithHardTimeout, startServers } from './live-check-process.mjs';

export const BASELINE = Object.freeze({ PASS: 'pass', KNOWN_RED: 'known-red', ENV_SKIP: 'env-skip', FLAKY: 'flaky', UNRUN: 'unrun' });
export const VERDICT = Object.freeze({ OK: 'ok', IMPROVED: 'improved', REGRESSION: 'regression', SKIPPED: 'skipped' });
const STACK = Object.freeze({ PLAIN: 'plain', OIDC: 'oidc' });
const VITE_HOSTS = Object.freeze([LOOPBACK_V4, LOCALHOST]);
export const FLAKY_ATTEMPTS = 3;

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
    [entry.stepLines === undefined || typeof entry.stepLines === 'boolean', 'stepLines is a boolean'],
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

function relayIsolation(outDir, database, uploads) {
  return { YJS_HOST: LOOPBACK_V4, YJS_DB_DIR: join(outDir, database), YJS_UPLOADS_DIR: join(outDir, uploads) };
}

function relayService(entry, ports, outDir, secrets) {
  return {
    name: 'relay', command: process.execPath, args: [RELAY_SCRIPT], port: ports.relay, host: LOOPBACK_V4,
    env: {
      YJS_ALLOW_INSECURE_HTTP: ENV_TRUE, YJS_PORT: String(ports.relay),
      YJS_ROOM_CREATE_BURST: ROOM_CREATE_BURST, YJS_ROOM_CREATES_PER_HOUR: ROOM_CREATES_PER_HOUR,
      YJS_ALLOWED_ORIGINS: allowedOrigins(ports),
      ...oidcRelayEnv(entry, ports), ...maintainerEnv(entry, ports, secrets), ...entry.relayEnv,
      ...relayIsolation(outDir, 'db', 'uploads'),
    },
  };
}

function publicRelayService(ports, outDir) {
  return {
    name: 'public-relay', command: process.execPath, args: [RELAY_SCRIPT], port: ports.publicRelay, host: LOOPBACK_V4,
    env: {
      YJS_PUBLIC_WALL: ENV_TRUE, YJS_PORT: String(ports.publicRelay),
      YJS_ALLOW_INSECURE_HTTP: ENV_TRUE, YJS_ALLOWED_ORIGINS: allowedOrigins(ports),
      ...relayIsolation(outDir, 'public-db', 'public-db-uploads'),
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
  const relayOrigin = `http://${entry.viteHost}:${ports.relay}`;
  return { ...own, ...maintainerEnv(entry, ports, secrets), LIVE_CHECK_RELAY_ORIGIN: relayOrigin };
}

// ---------------------------------------------------------------- verdict

/**
 * Reads the `PASS <step>` / `FAIL <step>` lines runLiveCheck prints. A run passes only when it exits 0, prints no
 * FAIL line (fail-closed) and, unless the entry declares `stepLines: false`, at least one PASS line. A timeout
 * (even with exit zero) or a non-zero exit fails even when the script prints no FAIL. `stepLines: false` is for the scripts
 * that report in their own format (landing, ui) and so are judged by exit code alone.
 */
export function summarizeRun(stdout, exitCode, { requireStepLines = true, timedOut = false } = {}) {
  const steps = stdout.split('\n').map((line) => STEP_LINE.exec(line.trimEnd())).filter(Boolean);
  const failed = steps.filter(([, word]) => word === FAIL_WORD);
  return {
    passed: !timedOut && exitCode === 0 && failed.length === 0 && (steps.length > 0 || !requireStepLines),
    passLines: steps.length - failed.length,
    failLines: failed.length,
    failedStep: failed[0]?.[2] ?? null,
  };
}

/**
 * A failed attempt is the known red only when its first failed step equals `failingStep`. Scripts that print no
 * `FAIL <step>` line (landing, ui) fail with failedStep null, which matches
 * only a recorded `failingStep: null`.
 */
function judgeKnownRed(entry, attempts) {
  if (attempts.every((run) => run.passed)) return VERDICT.IMPROVED;
  return attempts.every((run) => run.passed || (!run.timedOut && run.failedStep === entry.failingStep)) ? VERDICT.OK : VERDICT.REGRESSION;
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
