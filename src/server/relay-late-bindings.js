import { STORAGE_FAILURE_LOG, STORAGE_FAILURE_REASON } from './relay-lifecycle.js';
import { roomLogId } from './relay-log-id.js';

const RELAY_BINDING_UNSET_MESSAGE = 'relay binding is unset';

export function createRelayLateBindings() {
  const values = new Map();
  const read = name => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`${RELAY_BINDING_UNSET_MESSAGE}: ${name}`);
    return value;
  };
  return {
    bind(name, value) { values.set(name, value); },
    get shutdown() { return read('shutdown'); },
    get activeRooms() { return read('activeRooms'); },
    get recoverRooms() { return read('recoverRooms'); },
    get deleteRoom() { return read('deleteRoom'); },
    get roomLockRoutes() { return read('roomLockRoutes'); },
    get e2eBlobs() { return read('e2eBlobs'); },
  };
}

export function createStorageFailureHandler({ accounting, bindings }) {
  const markStorageFailure = (err) => {
    if (accounting.storageFailure) return;
    accounting.storageFailure = err;
    console.error(STORAGE_FAILURE_LOG, { errorId: roomLogId(String(err)) });
    bindings.shutdown(STORAGE_FAILURE_REASON, true);
  };
  return markStorageFailure;
}
