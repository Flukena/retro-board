import { createRequire } from 'node:module';
import { roomLogId } from './relay-log-id.js';

const require = createRequire(import.meta.url);
// Same lib0 copy y-leveldb's CommonJS build uses, so values decode in getMeta.
const { encodeAny } = require('lib0/buffer');
const { keyEncoding } = require('y-leveldb');

export const STORAGE_FAILURE_CODE = 'STORAGE_FAILURE';
const META_KEY_VERSION = 'v1';
const META_KEY_KIND = 'meta';
const DURABLE_WRITE_OPTIONS = Object.freeze({ sync: true });
const PUT_OPERATION = 'put';
const DURABLE_META_BATCH_FAILURE = 'durable meta batch failed';

export const storageOperationError = (message) => Object.assign(new Error(message), {
  code: STORAGE_FAILURE_CODE,
});

// y-leveldb's _transact swallows every error: it catches, console.warn's the
// error, and resolves `null`. Its promises therefore NEVER reject, so a
// `.catch()` on any of these calls is dead code and a `.then()` runs even when
// the write failed. Each call has to be checked against its own success
// contract instead (verified in node_modules/y-leveldb/src/y-leveldb.js):
//   getYDoc       -> Y.Doc         | null on failure
//   storeUpdate   -> integer clock | null on failure
//   flushDocument -> undefined     | null on failure
// Returns the same operations, rejecting with a STORAGE_FAILURE error instead.
export function checkedStorage(ldb, Y) {
  const failIfNull = (result, message) => { if (result === null) throw storageOperationError(message); };
  return {
    async getYDoc(docName) {
      const doc = await ldb.getYDoc(docName);
      if (!(doc instanceof Y.Doc)) throw storageOperationError(`getYDoc failed: ${roomLogId(docName)}`);
      return doc;
    },
    async storeUpdate(docName, update) {
      const clock = await ldb.storeUpdate(docName, update);
      if (!Number.isInteger(clock)) throw storageOperationError(`storeUpdate failed: ${roomLogId(docName)}`);
      return clock;
    },
    // Same contract as flushDocument: `undefined` on success, `null` on failure.
    async clearDocument(docName) {
      failIfNull(await ldb.clearDocument(docName), `clearDocument failed: ${roomLogId(docName)}`);
    },
    // A successful flush resolves `undefined` — the callback y-leveldb passes to
    // _transact has no return statement — so only a strict `null` means failure.
    // `if (!result)` would treat every success as an error here.
    async flushDocument(docName) {
      failIfNull(await ldb.flushDocument(docName), `flushDocument failed: ${roomLogId(docName)}`);
    },
    async getAllDocNames() {
      const names = await ldb.getAllDocNames();
      if (!Array.isArray(names)) throw storageOperationError('getAllDocNames failed');
      return names;
    },
    async getMeta(docName, key) {
      const value = await ldb.getMeta(docName, key);
      failIfNull(value, `getMeta failed: ${roomLogId(docName)}`);
      return value;
    },
    async setMeta(docName, key, value) {
      failIfNull(await ldb.setMeta(docName, key, value), `setMeta failed: ${roomLogId(docName)}`);
    },
  };
}

const metaKey = (docName, key) => [META_KEY_VERSION, docName, META_KEY_KIND, key];
const levelMetaOperation = (docName, { type, key, value }) => (type === PUT_OPERATION
  ? { type, key: metaKey(docName, key), value: Buffer.from(encodeAny(value)) }
  : { type, key: metaKey(docName, key) });

// Exact bytes `ops` occupy once encoded as y-leveldb keys and encodeAny values (same path as metaBatch).
export const metaBatchBytes = (docName, ops) => ops
  .map((operation) => levelMetaOperation(docName, operation))
  .reduce((sum, { key, value }) => sum + keyEncoding.encode(key).byteLength + (value?.byteLength ?? 0), 0);

// Applies every put/del to `docName`'s meta keys as ONE atomic LevelDB batch.
// `durable` fsyncs it; the default unsynced batch matches storeUpdate for hot appends.
// Relies on y-leveldb 0.2.0 internals (package.json pins exactly 0.2.0; re-check on any
// upgrade): the private `_transact` queue (y-leveldb.js ~453), the
// ['v1', docName, 'meta', key] key layout (~311) and encodeAny values read back
// by getMeta (~560, ~577). `_transact` resolves null on any error and a
// successful batch resolves undefined, so only null means failure. The error
// message is fixed: keys can carry email addresses.
export const metaBatch = (ldb, docName, ops, options) => metaBatchAcross(ldb, [{ docName, ops }], options);

// Same as metaBatch, but one atomic batch spans the meta keys of several documents: `writes` is [{ docName, ops }].
export async function metaBatchAcross(ldb, writes, { durable = false } = {}) {
  const operations = writes.flatMap(({ docName, ops }) => ops.map((operation) => levelMetaOperation(docName, operation)));
  const options = durable ? DURABLE_WRITE_OPTIONS : undefined;
  const result = await ldb._transact((db) => db.batch(operations, options));
  if (result === null) throw storageOperationError(DURABLE_META_BATCH_FAILURE);
}

// Durable (fsynced) variant for records where setMeta's unsynced put is not enough (accounts).
export const durableMetaBatch = (ldb, docName, ops) => metaBatch(ldb, docName, ops, { durable: true });
