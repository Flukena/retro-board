import test from 'node:test';
import assert from 'node:assert/strict';
import { relayEntrypoint } from '../test-support/relay-entrypoint.js';
import * as storage from './relay-storage.js';
import { RoomRegistry } from './relay-room-registry.js';

const UTILS_PATH = new URL('../../node_modules/y-websocket/bin/utils.js', import.meta.url).pathname;
const WIPE_NAMES = ['first-wipe', 'second-wipe'];
const BOUND_PORT = 4321;

test('startup completes WIPE before hydrate and sets persistence before legacy migration', async t => {
  const order = [];
  const hydrate = RoomRegistry.prototype.hydrate;
  t.mock.method(RoomRegistry.prototype, 'hydrate', async function (...args) {
    order.push('hydrate');
    return hydrate.apply(this, args);
  });
  await relayEntrypoint(t, { env: { YJS_WIPE_DOCS: WIPE_NAMES.join(',') }, modules: {
    './src/server/relay-storage.js': { ...storage, checkedStorage: (...args) => ({
      ...storage.checkedStorage(...args),
      clearDocument: async name => { order.push(`start:${name}`); await Promise.resolve(); order.push(`end:${name}`); },
    }) },
    [UTILS_PATH]: { setPersistence() { order.push('setPersistence'); } },
    './src/server/legacy-image-migration.js': { migrateLegacyImages: async () => order.push('migrateLegacyImages') },
  } });
  assert.deepEqual(order, ['start:first-wipe', 'end:first-wipe', 'start:second-wipe', 'end:second-wipe', 'hydrate', 'setPersistence', 'migrateLegacyImages']);
});

test('listen banner preserves address, database and origin wording', async t => {
  const state = await relayEntrypoint(t);
  state.server.address = () => ({ port: BOUND_PORT });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args));
  state.listenCallback();
  assert.deepEqual(lines, [
    [`[yjs] listening on ws://127.0.0.1:${BOUND_PORT}  (db: ${state.root}/db)`],
    ['[yjs] origin allowlist: https://allowed.example'],
  ]);
});
