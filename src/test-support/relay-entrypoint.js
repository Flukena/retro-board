import { registerHooks, createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as localFiles from '../server/relay-local-files.js';
import * as lifecycle from '../server/relay-lifecycle.js';
import * as registry from '../server/relay-room-registry.js';
import * as maintenance from '../server/relay-maintenance.js';

const ENTRYPOINT = new URL('../../yjs-server.mjs', import.meta.url);
const SESSION_EVENTS = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'];
const TEST_SIGNING_KEY_BYTES = 32;
const SERVER_ROOT = new URL('../server/', import.meta.url).href;
const ISOLATED_MODULES = new Set(['relay-room-accounting.js']);
const require = createRequire(ENTRYPOINT);
let nextSessionId = 0;

// Import the complete, unmodified entrypoint through Node's module loader. Only
// boundary dependencies are injected; no source reads, slices or copied handlers.
export async function relayEntrypoint(t, { modules = {}, env = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-entrypoint-'));
  const syncProtocol = require('y-protocols/sync');
  const originalReadSyncMessage = syncProtocol.readSyncMessage;
  const state = { root, shutdowns: [], fatals: [], timers: [], measurements: [] };
  const priorEnv = { ...process.env };
  const priorListeners = new Map(SESSION_EVENTS.map(event => [event, process.listeners(event)]));
  const originalSetInterval = globalThis.setInterval;
  const sessionId = nextSessionId++;
  const bindingKey = `__retroRelayTest${sessionId}`;
  const bindings = boundaryModules(state, modules);
  globalThis[bindingKey] = bindings;
  Object.assign(process.env, {
    YJS_PORT: '0', YJS_HOST: '127.0.0.1', YJS_DB_DIR: join(root, 'db'),
    YJS_UPLOADS_DIR: join(root, 'uploads'), YJS_PUBLIC_WALL: 'false',
    YJS_ALLOWED_ORIGINS: 'https://allowed.example', YJS_ALLOW_INSECURE_HTTP: 'false',
    YJS_WIPE_DOCS: '', YJS_MIGRATE_DOCS: '', YJS_MAINTAINER_KEY: '',
    ...env,
  });
  const hooks = injectionHooks(bindings, bindingKey);
  globalThis.setInterval = (callback, intervalMs) => {
    const timer = { callback, intervalMs, unref() {} };
    state.timers.push(timer);
    return timer;
  };
  t.after(async () => {
    for (const event of SESSION_EVENTS) {
      for (const listener of process.listeners(event)) {
        if (!priorListeners.get(event).includes(listener)) process.off(event, listener);
      }
    }
    await state.registry?.activity.stop();
    await state.ldb?.destroy();
    delete globalThis[bindingKey];
    await rm(root, { recursive: true, force: true });
  });
  try {
    await import(`${ENTRYPOINT.href}?p1=${sessionId}`);
    state.handlers = new Map(SESSION_EVENTS.map(event => [event,
      process.listeners(event).filter(listener => !priorListeners.get(event).includes(listener))]));
    return state;
  } finally {
    hooks.deregister();
    globalThis.setInterval = originalSetInterval;
    syncProtocol.readSyncMessage = originalReadSyncMessage;
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
  }
}

function injectionHooks(bindings, bindingKey) {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const serverParent = context.parentURL?.startsWith(SERVER_ROOT);
      const entryParent = context.parentURL?.startsWith(ENTRYPOINT.href);
      const key = serverParent && specifier.startsWith('./')
        ? `./src/server/${specifier.slice(2)}` : specifier;
      if ((entryParent || serverParent) && Object.hasOwn(bindings, key)) {
        return { url: `retro-test:${bindingKey}/${key}`, shortCircuit: true };
      }
      const result = nextResolve(specifier, context);
      if ((entryParent || serverParent) && result.url.startsWith(SERVER_ROOT)
          && ISOLATED_MODULES.has(result.url.slice(SERVER_ROOT.length).split('?')[0])) {
        return { ...result, url: `${result.url.split('?')[0]}?session=${bindingKey}` };
      }
      return result;
    },
    load(url, context, nextLoad) {
      const prefix = `retro-test:${bindingKey}/`;
      if (!url.startsWith(prefix)) return nextLoad(url, context);
      const specifier = url.slice(prefix.length);
      const source = Object.keys(bindings[specifier]).map(name =>
        `const ${name === 'default' ? 'defaultExport' : name} = globalThis[${JSON.stringify(bindingKey)}][${JSON.stringify(specifier)}][${JSON.stringify(name)}];\n` +
        (name === 'default' ? 'export default defaultExport;' : `export { ${name} };`)).join('\n');
      return { format: 'module', source, shortCircuit: true };
    },
  });
}

function boundaryModules(state, overrides) {
  const modules = {
    http: { default: { createServer(_options, dispatch) {
      state.dispatch = dispatch;
      state.server = Object.assign(new EventEmitter(), { listen() {} });
      return state.server;
    } } },
    module: { createRequire: () => {
      const wrapped = name => {
        if (name !== 'y-leveldb') return require(name);
        const actual = require(name);
        return { ...actual, LeveldbPersistence: class extends actual.LeveldbPersistence {
          constructor(...args) { super(...args); state.ldb = this; }
        } };
      };
      return wrapped;
    } },
    './src/server/relay-local-files.js': {
      ...localFiles,
      loadSessionSigningKey: () => Buffer.alloc(TEST_SIGNING_KEY_BYTES),
      loadSigningKey: () => Buffer.alloc(TEST_SIGNING_KEY_BYTES),
      directorySizeSync: (...args) => {
        state.measurements.push(args);
        return localFiles.directorySizeSync(...args);
      },
    },
    './src/server/relay-lifecycle.js': { ...lifecycle, createRelayLifecycle: options => {
      state.lifecycle = options;
      return {
        shutdown: (...args) => state.shutdowns.push(args),
        fatal: (...args) => state.fatals.push(args),
      };
    } },
    './src/server/relay-room-registry.js': { ...registry, RoomRegistry: class extends registry.RoomRegistry {
      constructor(options) { super(options); state.registry = this; state.persistence = options.persistence; }
    } },
    './src/server/relay-maintenance.js': { ...maintenance, RelayMaintenance: class extends EventEmitter {
      run(context) { state.maintenance = context; }
    } },
  };
  for (const [name, exports] of Object.entries(overrides)) modules[name] = { ...modules[name], ...exports };
  return modules;
}
