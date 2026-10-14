import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { realpathSync, mkdtempSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const BYTES_PER_MIB = 1024 * 1024;
const KIB_PER_MIB = 1024;
const BOARD_ITEM_COUNT = 15_000;
const ITEM_TEXT_LENGTH_CHARS = 2_040;
const ITEM_WIDTH_PX = 200;
const ITEM_HEIGHT_PX = 180;
const PROBE_DOC_NAME = 'hydration-probe';
const RESULT_PREFIX = 'RB_PROBE_RESULT ';
const NODE_ARGUMENT_OFFSET_COUNT = 2;
const PROBE_ITEMS_MAP_KEY = 'items';
const PROBE_ITEM_TYPE = 'sticky';
const PROBE_ITEM_TEXT_KEY = 'text';
const ITEM_TEXT_FILL_CHARACTER = 'x';
const PROBE_DB_DIRECTORY_NAME = 'db';
const PROBE_DIRECTORY_PREFIX = 'cold-hydration-';
const SEED_MODE = 'seed';
const HYDRATE_MODE = 'hydrate';
const HYDRATION_NODE_FLAGS = ['--expose-gc', '--trace-gc-nvp'];
const PROBE_PERSISTENCE_FAILURE_MESSAGE = 'probe persistence failed';
const PROBE_DIRECTORY_REQUIRED_MESSAGE = 'RB_PROBE_DIR is required; no fallback storage';
const HYDRATION_PHASES = {
  baseline: 'baseline', persisted: 'persisted-doc', encoded: 'encoded-update', live: 'live-doc',
};
const [mode, dbDir] = process.argv.slice(NODE_ARGUMENT_OFFSET_COUNT);

const seed = async () => {
  const persistence = new LeveldbPersistence(dbDir);
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      for (let index = 0; index < BOARD_ITEM_COUNT; index += 1) {
        const item = new Y.Map();
        doc.getMap(PROBE_ITEMS_MAP_KEY).set(`item-${index}`, item);
        for (const [key, value] of Object.entries({
          type: PROBE_ITEM_TYPE, x: index, y: index, w: ITEM_WIDTH_PX,
          h: ITEM_HEIGHT_PX, createdAt: index, zIndex: index,
        })) item.set(key, value);
        item.set(PROBE_ITEM_TEXT_KEY, new Y.Text(`${index}:`.padEnd(ITEM_TEXT_LENGTH_CHARS, ITEM_TEXT_FILL_CHARACTER)));
      }
    });
    const update = Y.encodeStateAsUpdate(doc);
    const clock = await persistence.storeUpdate(PROBE_DOC_NAME, update);
    if (!Number.isInteger(clock)) throw new Error(PROBE_PERSISTENCE_FAILURE_MESSAGE);
    console.log(RESULT_PREFIX + JSON.stringify({ encodedBytes: update.byteLength, items: BOARD_ITEM_COUNT }));
  } finally {
    doc.destroy();
    await persistence.destroy();
  }
};

const hydrate = async () => {
  const persistence = new LeveldbPersistence(dbDir);
  const liveDoc = new Y.Doc();
  const samples = [];
  const sample = (phase) => samples.push({ phase, ...process.memoryUsage() });
  try {
    globalThis.gc();
    sample(HYDRATION_PHASES.baseline);
    const persisted = await persistence.getYDoc(PROBE_DOC_NAME);
    sample(HYDRATION_PHASES.persisted);
    let update;
    try {
      update = Y.encodeStateAsUpdate(persisted);
      sample(HYDRATION_PHASES.encoded);
    } finally {
      persisted.destroy();
    }
    Y.applyUpdate(liveDoc, update);
    sample(HYDRATION_PHASES.live);
    console.log(RESULT_PREFIX + JSON.stringify({
      node: process.version, heapLimitBytes: getHeapStatistics().heap_size_limit,
      encodedBytes: update.byteLength, samples,
      peakRssMiB: process.resourceUsage().maxRSS / KIB_PER_MIB,
    }));
  } finally {
    liveDoc.destroy();
    await persistence.destroy();
  }
};

const runWorker = (workerMode, probeRoot, flags = []) => {
  const logPath = join(probeRoot, `${workerMode}.log`);
  const fd = openSync(logPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [
      ...process.execArgv, ...flags, fileURLToPath(import.meta.url),
      workerMode, join(probeRoot, PROBE_DB_DIRECTORY_NAME),
    ], { stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${workerMode} failed; see ${logPath}`);
  const log = readFileSync(logPath, 'utf8');
  const resultLine = log.split('\n').find((line) => line.startsWith(RESULT_PREFIX));
  const measurements = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
  const gcHeapBytes = [...log.matchAll(/total_size_before=(\d+)/g)].map((match) => Number(match[1]));
  const sampledHeapBytes = measurements.samples?.map((entry) => entry.heapUsed) || [];
  return { ...measurements, peakHeapUsedMiB: Math.max(0, ...gcHeapBytes, ...sampledHeapBytes) / BYTES_PER_MIB, logPath };
};

const runProbe = () => {
  const configuredRoot = process.env.RB_PROBE_DIR;
  if (!configuredRoot) throw new Error(PROBE_DIRECTORY_REQUIRED_MESSAGE);
  const root = realpathSync(configuredRoot);
  const probeRoot = mkdtempSync(join(root, PROBE_DIRECTORY_PREFIX));
  const seeded = runWorker(SEED_MODE, probeRoot);
  const hydrated = runWorker(HYDRATE_MODE, probeRoot, HYDRATION_NODE_FLAGS);
  console.log(JSON.stringify({ seeded, hydrated, probeRoot }, null, 2));
};

if (mode === SEED_MODE) await seed();
else if (mode === HYDRATE_MODE) await hydrate();
else runProbe();
