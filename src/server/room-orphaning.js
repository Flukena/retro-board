import { ROOM_KIND, orphanOwnerRecord } from '../domain/room-ownership.js';
import { roomLogId } from './relay-log-id.js';
import { STORAGE_FAILURE_CODE } from './relay-storage.js';

const ORPHAN_FAILED_LOG = '[yjs] room orphaning failed';
const STARTUP_ORPHANED_LOG = '[yjs] orphaned rooms of deleted accounts';
const ignoreFailure = () => {};

// A locked room made before owner records is owned through its lock: its orphaned record is built from the lock.
const ownerBase = (ownership, lock, now) => ownership.record ?? { kind: ROOM_KIND.BOARD, createdAt: lock?.createdAt ?? now };

async function orphanRoom({ registry, now, log, onStorageFailure }, docName) {
  const ownership = registry.ownershipOf(docName);
  if (!ownership || ownership.ownerAccountId === null) return false;
  const at = now();
  try {
    return await registry.setOwnerRecord(docName, orphanOwnerRecord(ownerBase(ownership, registry.lockFor(docName), at), at));
  } catch (error) {
    log.error(ORPHAN_FAILED_LOG, { docName: roomLogId(docName), err: error.message });
    if (error.code === STORAGE_FAILURE_CODE) onStorageFailure(error);
    return false;
  }
}

async function orphanAll(context, docNames) {
  let orphaned = 0;
  for (const docName of docNames) if (await orphanRoom(context, docName)) orphaned += 1;
  return orphaned;
}

/**
 * Rewrites every room the account owns to orphaned (kept, no owner); run right after the account is deleted. One
 * failed room is logged and skipped: startup reconciliation finishes it. Resolves the number orphaned.
 */
export function orphanAccountRooms({ registry, accountId, now = Date.now, log = console, onStorageFailure = ignoreFailure }) {
  return orphanAll({ registry, now, log, onStorageFailure }, registry.roomsOwnedBy(accountId));
}

/**
 * Startup reconciliation, once both the registry and the account store exist: orphans every room whose owner account
 * no longer exists. Covers a crash between the account delete and its orphaning, and a creation racing the delete.
 */
export async function orphanRoomsOfDeletedAccounts({ registry, accounts, now = Date.now, log = console, onStorageFailure = ignoreFailure }) {
  const owners = new Set([...registry.registeredDocs].map((docName) => registry.ownershipOf(docName).ownerAccountId));
  owners.delete(null);
  let orphaned = 0;
  for (const accountId of owners) {
    if (await accounts.get(accountId)) continue;
    orphaned += await orphanAccountRooms({ registry, accountId, now, log, onStorageFailure });
  }
  if (orphaned > 0) log.log(STARTUP_ORPHANED_LOG, { rooms: orphaned });
  return orphaned;
}
