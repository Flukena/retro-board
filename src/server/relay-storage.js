import { roomLogId } from './relay-log-id.js';

const STORAGE_FAILURE_CODE = 'STORAGE_FAILURE';

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
