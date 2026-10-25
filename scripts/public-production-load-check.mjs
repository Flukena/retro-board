#!/usr/bin/env node
// Explicit production admission probe: no item creation, edits, uploads or policy changes.
import assert from 'node:assert/strict';
import { resolve4 } from 'node:dns/promises';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'vite';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const PRODUCTION_ORIGIN = 'https://retroroom.party';
const PUBLIC_PATH = '/public';
const PUBLIC_WS_PATH = '/yjs-public/rooms/';
const FIXTURE_ROUTE = `${PRODUCTION_ORIGIN}/__public_load_fixture__.js`;
const PLAYWRIGHT_MODULE = '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const JOIN_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 300_000;
const VIEWPORT = { width: 1440, height: 900 };
const [outputArg, acknowledgement] = process.argv.slice(2);
assert.equal(acknowledgement, '--allow-production-load', 'Production load requires explicit invocation');
const output = resolve(outputArg);
assert.ok(output.startsWith(`${SSD_ROOT}/`));
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev, 'SSD must be mounted');
await mkdir(join(output, 'browser-temp'), { recursive: true });
process.env.TMPDIR = join(output, 'browser-temp');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = await build({ root, configFile: false, logLevel: 'silent',
  build: { write: false, minify: false, lib: { entry: join(root, 'scripts/public-browser-load-fixture.js'), name: 'PublicLoadFixture', formats: ['iife'] } } });
const outputs = Array.isArray(artifact) ? artifact : [artifact];
const bundle = outputs.flatMap(result => result.output).find(chunk => chunk.type === 'chunk').code;
const addresses = await resolve4(new URL(PRODUCTION_ORIGIN).hostname);
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP retroroom.party ${addresses[0]}`] });
const WORKER_COUNT = 5;
const CONNECTIONS_PER_WORKER = 100;
const MOTION_PARTICIPANTS_PER_WORKER = 2;
const REQUIRED_ROOM_CONNECTION_COUNT = 500;
const MAX_AWARENESS_P95_MS = 2000;
const report = { startedAt: new Date().toISOString(), url: `${PRODUCTION_ORIGIN}${PUBLIC_PATH}`,
  renderedBoards: WORKER_COUNT, websocketStatuses: {}, websocketErrors: 0, pageErrors: [], readiness: [], workers: [], capacityPassed: false };
let timer;

async function participant(index) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(() => { localStorage.setItem('rb_lang', 'en'); localStorage.setItem('rb_scroll_wheel_zoom', 'false'); });
  const page = await context.newPage();
  let endpoint;
  page.setDefaultTimeout(JOIN_TIMEOUT_MS);
  page.on('websocket', socket => { if (!endpoint && new URL(socket.url()).pathname.startsWith(PUBLIC_WS_PATH)) endpoint = socket.url(); });
  page.on('pageerror', error => report.pageErrors.push(error.name));
  page.on('console', event => {
    const prefix = 'PUBLIC_LOAD_PROGRESS ';
    if (event.text().startsWith(prefix)) console.log(JSON.stringify({ worker: index, ...JSON.parse(event.text().slice(prefix.length)) }));
  });
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  session.on('Network.webSocketHandshakeResponseReceived', event => {
    const status = event.response.status;
    report.websocketStatuses[status] = (report.websocketStatuses[status] || 0) + 1;
  });
  session.on('Network.webSocketFrameError', () => { report.websocketErrors++; });
  await page.goto(report.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.storage?.synced?.() === true);
  assert.ok(endpoint, 'Application Public WebSocket endpoint missing');
  if (await page.locator('#name-dialog-title').count()) await page.keyboard.press('Escape');
  await context.route(FIXTURE_ROUTE, route => route.fulfill({ contentType: 'application/javascript', body: bundle }));
  await page.addScriptTag({ url: FIXTURE_ROUTE });
  return { page, endpoint };
}

async function checkReadiness(page) {
  const result = await page.evaluate(async () => {
    const response = await fetch('/yjs-public/readyz', { cache: 'no-store' });
    return { status: response.status, ready: (await response.text()) === 'ready' };
  });
  report.readiness.push({ at: new Date().toISOString(), ...result });
  assert.ok(result.status === 200 && result.ready, 'Production relay readiness failed');
}

async function previewDigest(page) {
  const text = await page.evaluate(() => fetch('/yjs-public/api/snapshot', { cache: 'no-store' }).then(response => response.text()));
  return createHash('sha256').update(text).digest('hex');
}

try {
  const participants = [];
  for (let index = 0; index < WORKER_COUNT; index++) participants.push(await participant(index));
  const first = participants[0].page;
  report.presenceBefore = await first.evaluate(() => Object.keys(window.storage.getPresenceSnapshot()).length);
  report.previewHashBefore = await previewDigest(first);
  await checkReadiness(first);
  timer = setTimeout(() => { void browser.close(); }, RUN_TIMEOUT_MS);
  report.workers = await Promise.all(participants.map(({ page, endpoint }) => page.evaluate(
    ({ value, targetConnections, motionParticipants }) => window.PublicLoadFixture.run(value, { targetConnections, motionParticipants }),
    { value: endpoint, targetConnections: CONNECTIONS_PER_WORKER, motionParticipants: MOTION_PARTICIPANTS_PER_WORKER })));
  clearTimeout(timer);
  await checkReadiness(first);
  for (const { page } of participants) {
    await page.waitForFunction(() => window.storage.synced() === true);
    await page.waitForFunction(() => Object.keys(window.storage.getPresenceSnapshot()).every(id => !id.startsWith('production-load-')));
  }
  report.observersStillSynced = true;
  report.presenceAfter = await first.evaluate(() => Object.keys(window.storage.getPresenceSnapshot()).length);
  report.previewHashAfter = await previewDigest(first);
  report.publicPreviewUnchanged = report.previewHashBefore === report.previewHashAfter;
  report.roomPeakAwarenessSlots = Math.max(...report.workers.map(worker => worker.roomPeakAwarenessSlots));
  report.attempted = report.workers.reduce((count, worker) => count + worker.phases[0].attempted, 0);
  report.admittedTestConnections = report.workers.reduce((count, worker) => count + worker.phases[0].everSynced, 0);
  report.droppedAfterSync = report.workers.reduce((count, worker) => count + worker.phases.at(-1).droppedAfterSync, 0);
  report.capacityPassed = report.roomPeakAwarenessSlots >= REQUIRED_ROOM_CONNECTION_COUNT && report.droppedAfterSync === 0
    && report.workers.every(worker => worker.motion.awarenessP95Ms !== null && worker.motion.awarenessP95Ms < MAX_AWARENESS_P95_MS && worker.motion.latencySamples > 0);
  await first.screenshot({ path: join(output, 'public-after.png') });
  assert.deepEqual(report.pageErrors, []);
  assert.equal(report.attempted, REQUIRED_ROOM_CONNECTION_COUNT);
  console.log(JSON.stringify({ ts: new Date().toISOString(), attempted: report.attempted, admitted: report.admittedTestConnections,
    roomPeakAwarenessSlots: report.roomPeakAwarenessSlots, capacityPassed: report.capacityPassed }));
} finally {
  clearTimeout(timer);
  try { await browser.close(); }
  finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
}
if (!report.capacityPassed) process.exitCode = 1;
