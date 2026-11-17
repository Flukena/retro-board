// Test-only preload for a spawned relay (startRelay's `preload`): it reaches the relay's own deleter, which has no
// route before the owner routes exist, and can stall hydration or crash the process at chosen points.
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DeletionJournal, RoomDeletion } from '../server/room-deletion.js';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');
const { docs } = await import(pathToFileURL(require.resolve('y-websocket/bin/utils')).href);
const OK = 200;
const NOT_FOUND = 404;

let deletion = null;
const recover = RoomDeletion.prototype.recover;
RoomDeletion.prototype.recover = function captureDeleter() {
  deletion ??= this;
  return recover.call(this);
};

const held = new Map();
const getYDoc = LeveldbPersistence.prototype.getYDoc;
LeveldbPersistence.prototype.getYDoc = async function stallableGetYDoc(docName) {
  await held.get(docName)?.promise;
  return getYDoc.call(this, docName);
};

if (process.env.TEST_KILL_AFTER_JOURNAL_PUT) {
  const put = DeletionJournal.prototype.put;
  DeletionJournal.prototype.put = async function putThenCrash(...args) {
    await put.apply(this, args);
    process.kill(process.pid, 'SIGKILL');
  };
}

const hold = (docName) => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  held.set(docName, { promise, release });
  return {};
};
const release = (docName) => {
  held.get(docName)?.release();
  held.delete(docName);
  return {};
};
const ACTIONS = new Map([
  ['/delete', (docName) => deletion.deleteRoom(docName)],
  ['/hold', hold],
  ['/release', release],
  ['/state', (docName) => ({ resident: docs.has(docName) })],
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://hook');
  const action = ACTIONS.get(url.pathname);
  if (!action) { res.writeHead(NOT_FOUND); res.end(); return; }
  const result = await action(url.searchParams.get('doc'));
  res.writeHead(OK, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
});
server.unref();
server.listen(0, '127.0.0.1', () => console.log(`[deletion-hook] port ${server.address().port}`));
