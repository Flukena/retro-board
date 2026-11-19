import { EventEmitter } from 'node:events';
import { relayEntrypoint } from './relay-entrypoint.js';

const UTILS_PATH = new URL('../../node_modules/y-websocket/bin/utils.js', import.meta.url).pathname;
export const ALLOWED_ORIGIN = 'https://allowed.example';
export const TEST_DOC_NAME = 'policy-room';
export const TEST_ROOM_HANDLE = 'a'.repeat(32);

export async function connectionFixture(t, { inspection = () => ({ kind: 'other' }), parse = () => {}, parserCount = 1, modules = {}, env = {} } = {}) {
  const docs = new Map();
  const servers = [];
  const state = await relayEntrypoint(t, { env, modules: {
    ws: { WebSocketServer: class extends EventEmitter {
      clients = new Set();
      constructor() { super(); servers.push(this); }
    } },
    [UTILS_PATH]: {
      docs, setPersistence() {}, getYDoc: name => docs.get(name),
      setupWSConnection: conn => {
        for (let index = 0; index < parserCount; index++) conn.on('message', data => parse(conn, data));
      },
    },
    './src/server/relay-protocol.js': { RelayProtocol: class { inspect(data) { return inspection(data); } } },
    ...modules,
  } });
  const wss = servers[0];
  const connect = (doc, context = {}) => {
    docs.set(TEST_DOC_NAME, doc);
    const conn = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 0, closes: [],
      send(_data, callback) { callback?.(); },
      close(...args) { this.closes.push(args); }, terminate() {},
    });
    const req = { headers: { origin: ALLOWED_ORIGIN }, wsSecurityContext: {
      docName: TEST_DOC_NAME, clientIp: '127.0.0.1', expiresAt: null,
      expectedAwarenessClientId: null, ...context,
    } };
    wss.emit('connection', conn, req);
    return { conn, context: req.wsSecurityContext };
  };
  return { ...state, relayState: state, docs, wss, connect };
}
