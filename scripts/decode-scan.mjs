#!/usr/bin/env node
/**
 * Count board items that the client's remote-board decoder would hide.
 * Prints only counts, room sizes and field/type names — never board text,
 * names, tokens or document names.
 *
 * Usage (on a COPY of a stopped or backed-up LevelDB directory, never the live one):
 *   node scripts/decode-scan.mjs <leveldb-copy-dir>
 */
import { createRequire } from 'node:module';
import { decodeRemoteBoard } from '../src/remote-board-decoder.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const ITEMS_MAP = 'items';
const META_MAP = 'meta';
const INTERNAL_META_PREFIX = '__';
const BYTES_PER_MIB = 1024 * 1024;
const USAGE = 'usage: node scripts/decode-scan.mjs <leveldb-copy-dir>';

const readItems = (doc) => {
  const items = [];
  doc.getMap(ITEMS_MAP).forEach((yItem, id) => {
    if (!(yItem instanceof Y.Map)) return;
    const item = Object.assign(Object.create(null), { id });
    yItem.forEach((value, key) => { item[key] = value instanceof Y.Text ? value.toString() : value; });
    items.push(item);
  });
  return items;
};

const readMeta = (doc) => {
  const meta = Object.create(null);
  doc.getMap(META_MAP).forEach((value, key) => {
    if (!key.startsWith(INTERNAL_META_PREFIX)) meta[key] = value;
  });
  return meta;
};

const describeHidden = (item) => `type=${String(item.type)} fields=${Object.keys(item).sort().join(',')}`;

const scanDoc = (doc, summary) => {
  const items = readItems(doc);
  const meta = readMeta(doc);
  const decoded = decodeRemoteBoard(items, meta);
  const kept = new Set(decoded.items.map((item) => item.id));
  summary.items += items.length;
  items.filter((item) => !kept.has(item.id)).forEach((item) => {
    const reason = describeHidden(item);
    summary.hidden[reason] = (summary.hidden[reason] || 0) + 1;
  });
  Object.keys(meta).filter((key) => !Object.hasOwn(decoded, key)).forEach((key) => {
    summary.droppedMeta[key] = (summary.droppedMeta[key] || 0) + 1;
  });
  const encodedMiB = Y.encodeStateAsUpdate(doc).byteLength / BYTES_PER_MIB;
  summary.roomMiB.push(Number(encodedMiB.toFixed(2)));
};

const main = async (dir) => {
  if (!dir) { console.error(USAGE); process.exitCode = 1; return; }
  const db = new LeveldbPersistence(dir);
  const summary = { rooms: 0, items: 0, hidden: {}, droppedMeta: {}, roomMiB: [] };
  try {
    for (const name of await db.getAllDocNames()) {
      summary.rooms += 1;
      scanDoc(await db.getYDoc(name), summary);
    }
  } finally {
    await db.destroy();
  }
  summary.roomMiB.sort((a, b) => b - a);
  console.log(JSON.stringify(summary, null, 1));
};

await main(process.argv[2]);
