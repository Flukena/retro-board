#!/usr/bin/env node
// Sequential live-check runner (design §7.5): runs the checks in scripts/live-check-manifest.json one at a time, each
// against its own freshly started servers, and judges every run against the entry's recorded baseline.
//   node scripts/live-check-all.mjs --out-root <fresh dir on a data volume> [--only id,id] [--attempts n]
//   node scripts/live-check-all.mjs --list
// A port held by a process this runner did not start makes that check ENV-SKIP; the holder is never signalled.
// Exits non-zero on any regression, ENV-SKIP or interruption.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareDataVolumeOutput } from './board-live-helpers.mjs';
import {
  BASELINE, FLAKY_ATTEMPTS, PortHeldError, VERDICT, assertPortsFree, checkCommand, checkEnv, entryPorts, judgeRun,
  parseManifest, portsFor, runWithHardTimeout, serverPlan, startServers, summarizeRun,
} from './live-check-common.mjs';
import { PROJECT_ROOT } from './project-files.mjs';

const MANIFEST_PATH = join(PROJECT_ROOT, 'scripts', 'live-check-manifest.json');
const MAINTAINER_BUILD_DIR = 'dist-maintainer';
// 32 random bytes are 43 base64url characters, the relay's minimum maintainer key length (maintainer-server.js).
const MAINTAINER_KEY_BYTES = 32;
const JSON_INDENT_SPACES = 2;
// SIGALRM is what an outer `perl -e 'alarm N; exec @ARGV'` bound sends; without a handler it would orphan the servers.
const SHUTDOWN_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGALRM']);
const RUN_ENV_SKIP = 'env-skip';
const RUN_FAILED_EXIT_CODE = 1;
const USAGE = 'usage: node scripts/live-check-all.mjs --out-root <fresh dir on a data volume> [--only id,id] [--attempts n] | --list';

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { 'out-root': { type: 'string' }, only: { type: 'string' }, attempts: { type: 'string' }, list: { type: 'boolean' } },
  });
  const attempts = values.attempts === undefined ? undefined : Number(values.attempts);
  if (attempts !== undefined && !(Number.isInteger(attempts) && attempts > 0)) throw new Error(`--attempts must be a positive integer. ${USAGE}`);
  if (!values.list && !values['out-root']) throw new Error(USAGE);
  return { outRoot: values['out-root'], only: values.only?.split(','), attempts, list: Boolean(values.list) };
}

/** The selected entries with their manifest positions (which fix their ports), in file order. */
function selectEntries(manifest, only) {
  const indexed = manifest.entries.map((entry, index) => ({ entry, index }));
  if (!only) return indexed;
  const unknown = only.filter((id) => !manifest.entries.some((entry) => entry.id === id));
  if (unknown.length) throw new Error(`unknown live-check ids: ${unknown.join(', ')}`);
  return indexed.filter(({ entry }) => only.includes(entry.id));
}

const attemptsFor = (entry, override) => override ?? (entry.baseline === BASELINE.FLAKY ? FLAKY_ATTEMPTS : 1);

/** Why this run cannot start on this machine right now, or null. */
async function envSkipReason(entry, ports) {
  if (entry.maintainer && !existsSync(join(PROJECT_ROOT, MAINTAINER_BUILD_DIR))) {
    return `${MAINTAINER_BUILD_DIR}/ is missing; run npm run maintainer:build once`;
  }
  try {
    await assertPortsFree(ports);
    return null;
  } catch (error) {
    if (error instanceof PortHeldError) return `port ${error.port} in use`;
    throw error;
  }
}

async function freshRunDir(runDir) {
  // A reused directory would hand the relay an old db; room counts and plaintext scans assume an empty one.
  if (existsSync(runDir)) throw new Error(`${runDir} already exists; use a fresh --out-root`);
  return prepareDataVolumeOutput(runDir);
}

/** Starts the entry's servers, runs its check under the hard timeout, and always stops the servers again. */
async function runCheck(entry, ports, outDir, signal) {
  const used = entryPorts(entry, ports);
  const secrets = entry.maintainer ? { maintainerKey: randomBytes(MAINTAINER_KEY_BYTES).toString('base64url') } : {};
  const servers = await startServers(serverPlan(entry, ports, outDir, secrets), outDir);
  const started = Date.now();
  try {
    const run = await runWithHardTimeout([process.execPath, ...checkCommand(entry, ports, outDir)],
      { timeoutSec: entry.timeoutSec, env: checkEnv(entry, ports, secrets), signal });
    return { ...run, durationMs: Date.now() - started };
  } finally {
    await servers.stop();
    await assertPortsFree(used);
  }
}

/** One attempt in `runDir`: { envSkip } when it could not start, else its summary (also written to summary.json). */
async function runAttempt({ entry, ports, runDir, signal }) {
  const outDir = await freshRunDir(runDir);
  const skip = await envSkipReason(entry, entryPorts(entry, ports));
  if (skip) return { envSkip: skip };
  const run = await runCheck(entry, ports, outDir, signal);
  await writeFile(join(outDir, 'check-stdout.log'), run.stdout);
  await writeFile(join(outDir, 'check-stderr.log'), run.stderr);
  const { exitCode, timedOut, durationMs } = run;
  return { outDir, exitCode, timedOut, ...summarizeRun(run.stdout, exitCode, { requireStepLines: entry.stepLines !== false }), durationMs };
}

async function writeSummary(entry, attempts) {
  const { outDir, ...summary } = attempts.at(-1);
  const judged = judgeRun(entry, attempts);
  await writeFile(join(outDir, 'summary.json'), JSON.stringify({ id: entry.id, ...summary, judged }, null, JSON_INDENT_SPACES));
}

/** Runs one entry's attempts and prints its one result line; returns its verdict or RUN_ENV_SKIP. */
async function runEntry({ entry, index }, { outRoot, attempts: override, signal }) {
  if (entry.baseline === BASELINE.ENV_SKIP) {
    console.log(`SKIPPED ${entry.id}: recorded env-skip (${entry.reason})`);
    return VERDICT.SKIPPED;
  }
  const ports = portsFor(entry, index);
  const attempts = [];
  for (let n = 1; n <= attemptsFor(entry, override); n += 1) {
    const result = await runAttempt({ entry, ports, runDir: join(outRoot, entry.id, `run-${n}`), signal });
    if (result.envSkip) {
      console.log(`ENV-SKIP ${entry.id}: ${result.envSkip}`);
      return RUN_ENV_SKIP;
    }
    attempts.push(result);
    await writeSummary(entry, attempts);
    if (signal?.aborted || (entry.baseline === BASELINE.FLAKY && result.passed)) break;
  }
  const verdict = judgeRun(entry, attempts);
  const last = attempts.at(-1);
  console.log(`${verdict.toUpperCase()} ${entry.id} (${entry.baseline}): ${attempts.length} attempt(s), last exit ${last.exitCode}`
    + `${last.timedOut ? ' after timeout' : ''}, failed step ${JSON.stringify(last.failedStep)}, ${last.outDir}`);
  return verdict;
}

const readManifest = () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const runFailed = (verdict) => verdict === VERDICT.REGRESSION || verdict === RUN_ENV_SKIP;

/** The CLI; returns the process exit code. `manifest` and `signal` are injectable for tests and the signal handler. */
export async function main(argv, { manifest: json = readManifest(), signal } = {}) {
  const options = parseCli(argv);
  const manifest = parseManifest(json);
  if (options.list) {
    for (const { id } of manifest.entries) console.log(id);
    return 0;
  }
  const outRoot = await prepareDataVolumeOutput(options.outRoot);
  const verdicts = [];
  for (const selected of selectEntries(manifest, options.only)) {
    if (signal?.aborted) break;
    const verdict = await runEntry(selected, { outRoot, attempts: options.attempts, signal }).catch((error) => {
      throw new Error(`${selected.entry.id}: ${error.message}`, { cause: error });
    });
    verdicts.push(verdict);
  }
  return verdicts.some(runFailed) || signal?.aborted ? RUN_FAILED_EXIT_CODE : 0;
}

/** An AbortController that aborts on the first shutdown signal, so the running check and its servers stop cleanly. */
export function abortOnShutdownSignals() {
  const controller = new AbortController();
  for (const name of SHUTDOWN_SIGNALS) {
    process.once(name, () => {
      console.error(`live-check-all: ${name}; stopping the running check and its servers`);
      controller.abort();
    });
  }
  return controller;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const controller = abortOnShutdownSignals();
  try {
    process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
  } catch (error) {
    console.error(`live-check-all: ${error.message}`);
    process.exitCode = RUN_FAILED_EXIT_CODE;
  }
}
