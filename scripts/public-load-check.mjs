#!/usr/bin/env node
// Real Yjs providers against a dedicated loopback relay; never a production URL.
import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { createMotionPublisher, sendOnlyLocalAwareness } from '../src/client/session/awareness-transport.js';
import { PUBLIC_RELAY_PREFIX, PUBLIC_SESSION_ROUTE } from '../src/domain/public-wall-contract.js';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const TARGET_CLIENT_COUNT = 500;
const LOOP_SAMPLE_RESOLUTION_MS = 20;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_SAMPLE_RESOLUTION_MS });
loopDelay.enable();
const JOIN_POLL_INTERVAL_MS = 50;
const JOIN_PACE_MS = 150;
const JOIN_TIMEOUT_MS = 5000;
const CONVERGENCE_TIMEOUT_MS = 10000;
const IDLE_DURATION_MS = 35000;
const ACTIVE_DURATION_MS = 15000;
const ACTIVE_INTERVAL_MS = 100;
const SEED_CARD_COUNT = 100;
const SEED_COLOR_COUNT = 5;
const MILLISECONDS_PER_SECOND = 1000;
const MAX_AWARENESS_P95_MS = 2000;
// Allow scheduler jitter while requiring at least90% of the requested sending rate.
const MIN_ACTIVE_RATE_RATIO = 0.9;
const MIN_ACTIVE_ROUNDS = Math.floor(ACTIVE_DURATION_MS / ACTIVE_INTERVAL_MS * MIN_ACTIVE_RATE_RATIO);
const SEED_TEXT_CHARACTERS = 600;
const TEXT_WIDTH_PX = 280;
const TEXT_HEIGHT_PX = 240;
const ORIGIN = 'https://load.example';
const [baseArg, outputArg, workload = 'all-active'] = process.argv.slice(2);
assert.ok(['all-active', 'mixed'].includes(workload));
const MIXED_ACTIVE_CLIENT_COUNT = 10;
const MIXED_EDIT_INTERVAL_ROUNDS = 5;
const HEARTBEAT_INTERVAL_MS = 5000;
assert.ok(baseArg && outputArg, 'Pass isolated relay URL and SSD output directory');
const base = new URL(baseArg);
assert.ok(base.hostname === '127.0.0.1' && base.port === '1269' && base.protocol === 'http:', 'Only loopback port 1269 is permitted');
const output = resolve(outputArg);
assert.ok(output.startsWith(`${SSD_ROOT}/`), 'Artifacts must be on the operator SSD');
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev, 'SSD must be mounted');
await mkdir(output, { recursive: true });
const report = { workload, targetClients: TARGET_CLIENT_COUNT, phases: [], closeCodes: {}, upgradeStatuses: {}, errors: 0 };
const clients = [];
let cleaningUp = false;
process.setMaxListeners(TARGET_CLIENT_COUNT * 2);

function summarizePhase(name, startedAt, extra = {}) {
  const rosterSizes = clients.map(client => client.provider.awareness.getStates().size);
  const phase = { name, rosterMin: Math.min(...rosterSizes), rosterMax: Math.max(...rosterSizes),
    fullRosterClients: rosterSizes.filter(size => size === TARGET_CLIENT_COUNT).length,
    driverLoopP95Ms: loopDelay.percentile(95) / NANOSECONDS_PER_MILLISECOND,
    driverLoopMaxMs: loopDelay.max / NANOSECONDS_PER_MILLISECOND, driverRssBytes: process.memoryUsage().rss, durationMs: Date.now() - startedAt,
    connected: clients.filter(client => client.provider.wsconnected).length,
    synced: clients.filter(client => client.provider.synced).length, ...extra };
  loopDelay.reset();
  report.phases.push(phase);
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...phase }));
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(JOIN_POLL_INTERVAL_MS);
  return predicate();
}

function createClient(index, credentials) {
  let rejected = false;
  class Socket extends WebSocket {
    constructor(address, protocols) {
      super(address, protocols, { headers: { origin: ORIGIN, cookie: credentials.cookie } });
      this.on('unexpected-response', (_request, response) => {
        report.upgradeStatuses[response.statusCode] = (report.upgradeStatuses[response.statusCode] || 0) + 1;
        rejected = true; response.resume(); this.terminate();
      });
      this.on('close', code => {
        if (!cleaningUp) report.closeCodes[code] = (report.closeCodes[code] || 0) + 1;
      });
      this.on('error', () => { if (!cleaningUp) report.errors++; });
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${base.href.replace('http:', 'ws:')}${PUBLIC_RELAY_PREFIX.slice(1)}`,
    `rooms/${credentials.roomHandle}`, doc, { connect: false, disableBc: true,
      WebSocketPolyfill: Socket, params: { awarenessId: String(doc.clientID) } });
  sendOnlyLocalAwareness(provider);
  provider.awareness.setLocalStateField('user', { userId: `load-${index}`, name: `Load ${index}`, lastSeen: Date.now() });
  provider.on('connection-close', () => { provider.shouldConnect = false; });
  const client = { doc, provider, motion: createMotionPublisher(provider.awareness), rejected: () => rejected };
  clients.push(client);
  provider.connect();
  return client;
}

function seedBoard(doc) {
  assert.equal(doc.getMap('items').size, 0, 'Load check requires a fresh isolated Public board');
  doc.transact(() => {
    for (let index = 0; index < SEED_CARD_COUNT; index++) {
      const card = new Y.Map();
      const fields = { id: `seed-${index}`, type: 'sticky', x: index * TEXT_WIDTH_PX, y: 0,
        w: TEXT_WIDTH_PX, h: TEXT_HEIGHT_PX, color: index % SEED_COLOR_COUNT, private: false, createdAt: Date.now() };
      for (const [key, value] of Object.entries(fields)) card.set(key, value);
      card.set('text', new Y.Text('x'.repeat(SEED_TEXT_CHARACTERS)));
      doc.getMap('items').set(fields.id, card);
    }
  });
}

async function joinClients(credentials) {
  const started = Date.now();
  for (let index = 0; index < TARGET_CLIENT_COUNT; index++) {
    const client = createClient(index, credentials);
    await waitUntil(() => client.provider.synced || client.rejected(), JOIN_TIMEOUT_MS);
    if (index === 0 && client.provider.synced) { seedBoard(client.doc); await delay(JOIN_POLL_INTERVAL_MS); }
    await delay(JOIN_PACE_MS);
  }
  const rosterConverged = await waitUntil(() => clients.every(client =>
    client.provider.awareness.getStates().size === TARGET_CLIENT_COUNT), CONVERGENCE_TIMEOUT_MS);
  summarizePhase('admission', started, { rosterConverged, boardBytes: Y.encodeStateAsUpdate(clients[0].doc).byteLength });
}

async function activeClients() {
  const started = Date.now();
  const active = workload === 'mixed' ? clients.slice(0, MIXED_ACTIVE_CLIENT_COUNT) : clients;
  const editIntervalRounds = workload === 'mixed' ? MIXED_EDIT_INTERVAL_ROUNDS : 1;
  const latencies = [];
  const observer = clients[0].provider.awareness;
  const captureLatency = ({ added, updated }) => {
    for (const id of [...added, ...updated]) {
      const state = observer.getStates().get(id);
      if (id !== observer.clientID && state?.cursor?.updatedAt) latencies.push(Date.now() - state.cursor.updatedAt);
    }
  };
  observer.on('change', captureLatency);
  let sequence = 0;
  let editSequence = 0;
  try {
    while (Date.now() - started < ACTIVE_DURATION_MS && clients.every(client => client.provider.wsconnected)) {
      sequence++;
      const now = Date.now();
      const editNow = sequence % editIntervalRounds === 0;
      if (editNow) editSequence++;
      active.forEach(({ doc, motion }, index) => {
        motion.set('cursor', { x: sequence, y: index, updatedAt: now });
        motion.set('view', { x: sequence, y: index, zoom: 1, updatedAt: now });
        if (editNow) doc.getMap('load-edits').set(`load-${index}`, editSequence);
      });
      await delay(ACTIVE_INTERVAL_MS);
    }
    const converged = await waitUntil(() => clients.every(client =>
      client.doc.getMap('load-edits').size === active.length
      && [...client.doc.getMap('load-edits').values()].every(value => value === editSequence)), CONVERGENCE_TIMEOUT_MS);
    latencies.sort((first, second) => first - second);
    const P95_QUANTILE = 0.95;
    summarizePhase('active', started, { activeClients: active.length, finalEditSequence: editSequence, requestedMotionHzPerClient: MILLISECONDS_PER_SECOND / ACTIVE_INTERVAL_MS,
      requestedEditsHzPerClient: MILLISECONDS_PER_SECOND / ACTIVE_INTERVAL_MS / editIntervalRounds, rounds: sequence, converged,
      latencySamples: latencies.length, awarenessP95Ms: latencies[Math.floor(latencies.length * P95_QUANTILE)] ?? null });
  } finally { observer.off('change', captureLatency); }
}

const heartbeat = setInterval(() => {
  clients.forEach(({ provider }, index) => {
    if (provider.wsconnected) provider.awareness.setLocalStateField('user', { userId: `load-${index}`, name: `Load ${index}`, lastSeen: Date.now() });
  });
}, HEARTBEAT_INTERVAL_MS);

try {
  const response = await fetch(new URL(`${PUBLIC_RELAY_PREFIX}${PUBLIC_SESSION_ROUTE}`, base), { method: 'POST', headers: { origin: ORIGIN } });
  assert.equal(response.status, 200);
  // Shared room-scoped test credential avoids conflating session-API limits with socket capacity.
  const credentials = { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
  await joinClients(credentials);
  if (clients.every(client => client.provider.wsconnected)) {
    const started = Date.now();
    await delay(IDLE_DURATION_MS);
    summarizePhase('idle', started, { rosterConverged: clients.every(client => client.provider.awareness.getStates().size === TARGET_CLIENT_COUNT) });
    if (clients.every(client => client.provider.wsconnected)) await activeClients();
  }
  const ready = await fetch(new URL(`${PUBLIC_RELAY_PREFIX}/readyz`, base));
  report.readyStatus = ready.status;
  report.ready = await ready.text();
  report.pass = report.phases.length === 3 && report.phases.every(phase => phase.connected === TARGET_CLIENT_COUNT)
    && report.phases.every(phase => phase.rosterConverged !== false)
    && report.phases.at(-1).converged && report.phases.at(-1).rounds >= MIN_ACTIVE_ROUNDS
    && report.phases.at(-1).latencySamples > 0 && report.phases.at(-1).awarenessP95Ms < MAX_AWARENESS_P95_MS
    && report.readyStatus === 200 && report.ready === 'ready';
} finally {
  clearInterval(heartbeat);
  loopDelay.disable();
  cleaningUp = true;
  for (const { motion, provider, doc } of clients) { motion.destroy(); provider.destroy(); doc.destroy(); }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
if (!report.pass) process.exitCode = 1;
