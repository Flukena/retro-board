export const STORE_CAPACITY_CODE = 'TEST_CAPACITY';

/** A shared pending-store counter like the relay's registryPersistence.reserveStore: op and byte caps. */
export function sharedReservations({ maxOps = Infinity, maxBytes = Infinity } = {}) {
  const state = { pending: 0, pendingBytes: 0, taken: 0, released: 0, reservedBytes: [] };
  state.reserveStore = (bytes) => {
    if (state.pending >= maxOps || state.pendingBytes + bytes > maxBytes) {
      throw Object.assign(new Error('pending capacity'), { code: STORE_CAPACITY_CODE });
    }
    state.pending += 1;
    state.pendingBytes += bytes;
    state.taken += 1;
    state.reservedBytes.push(bytes);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      state.pending -= 1;
      state.pendingBytes -= bytes;
      state.released += 1;
    };
  };
  return state;
}
