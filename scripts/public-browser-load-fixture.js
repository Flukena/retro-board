import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { createMotionPublisher, sendOnlyLocalAwareness } from '../src/client/session/awareness-transport.js';
import { PUBLIC_RELAY_PREFIX } from '../src/domain/public-wall-contract.js';

const TARGET_CONNECTION_COUNT = 500;
const OBSERVER_CONNECTION_COUNT = 1;
const JOIN_TIMEOUT_MS = 10_000;
const JOIN_PACE_MS = 100;
const IDLE_DURATION_MS = 35_000;
const ACTIVE_DURATION_MS = 15_000;
const MOTION_INPUT_INTERVAL_MS = 100;
const MAX_MOTION_PARTICIPANT_COUNT = 10;
const HEARTBEAT_INTERVAL_MS = 5000;
const PROGRESS_INTERVAL_COUNT = 50;
const CURSOR_ORIGIN_WORLD_PX = -10_000;
const CURSOR_SPACING_WORLD_PX = 10;
const MAX_LATENCY_SAMPLE_COUNT = 100_000;
const P95_QUANTILE = 0.95;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function progress(value) {
  console.log(`PUBLIC_LOAD_PROGRESS ${JSON.stringify({ ts: new Date().toISOString(), ...value })}`);
}

function newClient(endpoint, index, prefix) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${endpoint.origin}${PUBLIC_RELAY_PREFIX}`,
    `rooms/${endpoint.pathname.split('/').at(-1)}`, doc, { connect: false, disableBc: true,
      params: { awarenessId: String(doc.clientID) } });
  sendOnlyLocalAwareness(provider);
  const user = { userId: `${prefix}-${index}`, name: 'Public load test', lastSeen: Date.now() };
  provider.awareness.setLocalStateField('user', user);
  const client = { doc, provider, user, motion: createMotionPublisher(provider.awareness), joined: false, closedAfterJoin: 0 };
  provider.on('connection-close', () => {
    provider.shouldConnect = false;
    if (client.joined) client.closedAfterJoin++;
  });
  return client;
}

async function join(client) {
  const { provider } = client;
  await new Promise(resolveJoin => {
    let settled = false;
    const finish = joined => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.joined = joined;
      provider.off('sync', onSync);
      provider.off('connection-close', onClose);
      if (!joined) provider.disconnect();
      resolveJoin();
    };
    const onSync = synced => { if (synced) finish(true); };
    const onClose = () => finish(false);
    const timeout = setTimeout(() => finish(false), JOIN_TIMEOUT_MS);
    provider.on('sync', onSync);
    provider.on('connection-close', onClose);
    provider.connect();
  });
}

function connectionCounts(clients) {
  return { attempted: clients.length + OBSERVER_CONNECTION_COUNT,
    everSynced: clients.filter(client => client.joined).length + OBSERVER_CONNECTION_COUNT,
    connected: clients.filter(client => client.provider.wsconnected).length + OBSERVER_CONNECTION_COUNT,
    rejectedOrTimedOut: clients.filter(client => !client.joined).length,
    droppedAfterSync: clients.reduce((total, client) => total + client.closedAfterJoin, 0),
    roomAwarenessSlots: Math.max(0, ...clients.filter(client => client.provider.synced).map(client => client.provider.awareness.getStates().size)) };
}

async function measureMotion(clients, participantCount) {
  const admitted = clients.filter(client => client.provider.wsconnected).slice(0, participantCount);
  if (!admitted.length) return { participants: 0, rounds: 0 };
  const latencies = [];
  const awareness = admitted[0].provider.awareness;
  const capture = ({ added, updated }) => {
    for (const id of [...added, ...updated]) {
      const state = awareness.getStates().get(id);
      const sentAt = state?.user?.name === 'Public load test' && state.cursor?.updatedAt;
      if (id !== awareness.clientID && sentAt && latencies.length < MAX_LATENCY_SAMPLE_COUNT) latencies.push(Date.now() - sentAt);
    }
  };
  awareness.on('change', capture);
  const started = Date.now();
  let rounds = 0;
  try {
    while (Date.now() - started < ACTIVE_DURATION_MS && admitted.every(client => client.provider.wsconnected)) {
      rounds++;
      const now = Date.now();
      admitted.forEach(({ motion }, index) => {
        const x = CURSOR_ORIGIN_WORLD_PX + rounds;
        const y = CURSOR_ORIGIN_WORLD_PX + index * CURSOR_SPACING_WORLD_PX;
        motion.set('cursor', { x, y, updatedAt: now });
        motion.set('view', { x, y, zoom: 1, updatedAt: now });
      });
      await delay(MOTION_INPUT_INTERVAL_MS);
    }
    latencies.sort((first, second) => first - second);
    return { participants: admitted.length, rounds, durationMs: Date.now() - started,
      awarenessP95Ms: latencies[Math.floor(latencies.length * P95_QUANTILE)] ?? null, latencySamples: latencies.length };
  } finally { awareness.off('change', capture); }
}

export async function run(endpointValue, { targetConnections = TARGET_CONNECTION_COUNT, motionParticipants = MAX_MOTION_PARTICIPANT_COUNT } = {}) {
  if (!Number.isInteger(targetConnections) || targetConnections < OBSERVER_CONNECTION_COUNT || targetConnections > TARGET_CONNECTION_COUNT) throw new Error('Invalid connection count');
  if (!Number.isInteger(motionParticipants) || motionParticipants < OBSERVER_CONNECTION_COUNT || motionParticipants > MAX_MOTION_PARTICIPANT_COUNT) throw new Error('Invalid motion participant count');
  if (location.origin !== 'https://retroroom.party' || location.pathname !== '/public') throw new Error('Production Public page required');
  const endpoint = new URL(endpointValue);
  if (endpoint.origin !== 'wss://retroroom.party' || !endpoint.pathname.startsWith(`${PUBLIC_RELAY_PREFIX}/rooms/`)) throw new Error('Wrong Public endpoint');
  const clients = [];
  const report = { targetConnections, browserObservers: OBSERVER_CONNECTION_COUNT,
    separateRenderedBoards: OBSERVER_CONNECTION_COUNT, canonicalBoardWrites: 0, roomPeakAwarenessSlots: 0, phases: [] };
  const prefix = `production-load-${crypto.randomUUID()}`;
  const heartbeat = setInterval(() => {
    for (const { provider, user } of clients) {
      if (provider.wsconnected) provider.awareness.setLocalStateField('user', { ...user, lastSeen: Date.now() });
    }
  }, HEARTBEAT_INTERVAL_MS);
  try {
    for (let index = 0; index < targetConnections - OBSERVER_CONNECTION_COUNT; index++) {
      const client = newClient(endpoint, index, prefix);
      clients.push(client);
      if (index === 0) client.provider.awareness.on('change', () => {
        report.roomPeakAwarenessSlots = Math.max(report.roomPeakAwarenessSlots, client.provider.awareness.getStates().size);
      });
      await join(client);
      if ((clients.length + OBSERVER_CONNECTION_COUNT) % PROGRESS_INTERVAL_COUNT === 0) progress(connectionCounts(clients));
      await delay(JOIN_PACE_MS);
    }
    report.phases.push({ name: 'admission', ...connectionCounts(clients) });
    progress(report.phases.at(-1));
    await delay(IDLE_DURATION_MS);
    report.phases.push({ name: 'idle', durationMs: IDLE_DURATION_MS, ...connectionCounts(clients) });
    report.motion = await measureMotion(clients, motionParticipants);
    report.phases.push({ name: 'motion', ...connectionCounts(clients) });
    report.all500Admitted = report.phases[0].everSynced === targetConnections;
    return report;
  } finally {
    clearInterval(heartbeat);
    for (const { motion, provider, doc } of clients) { motion.destroy(); provider.destroy(); doc.destroy(); }
    progress({ name: 'cleanup', releasedTestClients: clients.length });
  }
}
