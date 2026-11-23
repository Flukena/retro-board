import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './project-files.mjs';
import { PUBLIC_RELAY_PORT } from '../src/server/public-wall-config.js';
import {
  BASELINE, checkCommand, checkEnv, entryPorts, judgeRun, parseManifest, portsFor,
  serverPlan, summarizeRun,
} from './live-check-common.mjs';

const MAINTAINER_KEY_BYTES = 32;
// Design §7.5 / task-1 brief: vite 5301+i, relay 1301+i, oidc 4401+i, maintainer 1351+i.
const FIRST_VITE_PORT = 5301;
// pan-live-check.mjs asserts its own fixed Vite port.
const PAN_VITE_PORT = 5188;
const entryOf = (overrides = {}) => ({
  id: 'ui', script: 'scripts/ui-live-check.mjs', args: ['--base-url', '{base}', '--out', '{out}'], stack: 'plain',
  viteHost: '127.0.0.1', ports: {}, publicRelay: false, maintainer: false, relayEnv: {}, checkEnv: {},
  timeoutSec: 900, baseline: BASELINE.UNRUN, ...overrides,
});
const manifestOf = (...entries) => ({ entries });
const attempt = (passed, failedStep = null) => ({ passed, passLines: passed ? 1 : 0, failLines: passed ? 0 : 1, failedStep });

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
const committedManifestJson = () => JSON.parse(readFileSync(new URL('./live-check-manifest.json', import.meta.url), 'utf8'));

test('the committed manifest has no unrun entry', () => {
  assert.doesNotThrow(() => parseManifest(committedManifestJson(), { requireRun: true }));
});

test("every committed entry's script exists", () => {
  for (const entry of committedManifestJson().entries) {
    assert.ok(existsSync(join(PROJECT_ROOT, entry.script)), `${entry.id}: ${entry.script}`);
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
  const relay = plan.find((service) => service.name === 'relay');
  assert.equal(relay.env.YJS_MAINTAINER_KEY, maintainerKey);
  const check = checkEnv(entry, ports, { maintainerKey });
  assert.equal(check.YJS_MAINTAINER_KEY, maintainerKey);
  assert.equal(check.LIVE_CHECK_RELAY_ORIGIN, `http://${entry.viteHost}:${relay.port}`);
});

test('checkCommand substitutes {base} and {out}', () => {
  const entry = entryOf();
  assert.deepEqual(checkCommand(entry, portsFor(entry, 0), '/data/run-1'),
    ['scripts/ui-live-check.mjs', '--base-url', `http://127.0.0.1:${FIRST_VITE_PORT}`, '--out', '/data/run-1']);
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


test('zero PASS lines fail even on exit zero', () => {
  const run = summarizeRun('setup complete\n', 0);
  assert.equal(run.passLines, 0);
  assert.equal(run.passed, false);
  assert.equal(judgeRun(entryOf({ baseline: BASELINE.PASS }), [run]), 'regression');
});

function assertSyncWaitPredicates(source, file) {
  const asyncBindings = new Set([...source.matchAll(/\basync\s+function\s+(\w+)|\b(?:const|let)\s+(\w+)\s*=\s*async\b/g)]
    .map(([, declaration, binding]) => declaration ?? binding));
  for (const [, firstWord] of source.matchAll(/\.waitForFunction\s*\(\s*(\w+)/g)) {
    assert.ok(firstWord !== 'async' && !asyncBindings.has(firstWord), `${file}: async predicate ${firstWord}`);
  }
}

test('live scripts use synchronous Playwright wait predicates, including named callbacks', () => {
  const scripts = new Set(committedManifestJson().entries.map(({ script }) => script));
  scripts.add('scripts/board-live-helpers.mjs');
  for (const file of scripts) assertSyncWaitPredicates(readFileSync(join(PROJECT_ROOT, file), 'utf8'), file);
});

test('the wait guard catches multiline and named async predicates', () => {
  for (const source of [
    'page.waitForFunction(\n  async () => false)',
    'async function ready() { return false; } page.waitForFunction(ready)',
    'const ready = async () => false; page.waitForFunction(ready, value)',
  ]) assert.throws(() => assertSyncWaitPredicates(source, 'fixture'), /async predicate/);
  assertSyncWaitPredicates('const ready = () => true; page.waitForFunction(ready)', 'fixture');
});

test('an entry declaring stepLines: false is judged by exit code alone', () => {
  const quiet = { requireStepLines: false };
  assert.equal(summarizeRun('PASS: 19/19 steps\n', 0, quiet).passed, true);
  assert.equal(summarizeRun('PASS: 19/19 steps\n', 1, quiet).passed, false);
  assert.equal(summarizeRun('FAIL broken step\n', 0, quiet).passed, false);
  assert.equal(summarizeRun('PASS: 19/19 steps\n', 0).passed, false);
});

test('stepLines must be a boolean', () => {
  assert.throws(() => parseManifest(manifestOf(entryOf({ stepLines: 'no' }))), /stepLines is a boolean/);
  assert.doesNotThrow(() => parseManifest(manifestOf(entryOf({ stepLines: false }))));
});

test('a timed-out process that handles SIGTERM and exits zero cannot pass', () => {
  const partial = summarizeRun('PASS board opened\n', 0, { timedOut: true });
  assert.equal(partial.passed, false);
  assert.equal(partial.passLines, 1);
});

test('a timeout cannot match a recorded known failure with no FAIL line', () => {
  const entry = entryOf({ baseline: BASELINE.KNOWN_RED, reason: 'known assertion', failingStep: null });
  assert.equal(judgeRun(entry, [{ ...attempt(false), timedOut: true }]), 'regression');
});
