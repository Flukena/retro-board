const CLIENT_REF_RANGE = 2 ** 32;
/** clientRef 0 is the relay's "no entry" marker (snapshot and malformed-frame rejects), so it is never allocated. */
const NO_CLIENT_REF = 0;
const FIRST_CLIENT_REF = 1;

const nextRef = (ref) => {
  const next = (ref + 1) % CLIENT_REF_RANGE;
  return next === NO_CLIENT_REF ? FIRST_CLIENT_REF : next;
};

/**
 * Local Yjs updates that the relay has not acknowledged yet, in creation order.
 * An entry leaves only on the ACK with its clientRef, or when an accepted snapshot already holds it.
 */
export class PendingDeliveries {
  #entries = new Map();
  #cursor;

  constructor({ firstClientRef = FIRST_CLIENT_REF } = {}) {
    this.#cursor = firstClientRef === NO_CLIENT_REF ? FIRST_CLIENT_REF : firstClientRef;
  }

  get size() { return this.#entries.size; }

  /** Adds an update under the next free clientRef; refs wrap at 2^32 and skip 0 and refs still pending. */
  add(update, { oversized = false } = {}) {
    while (this.#entries.has(this.#cursor)) this.#cursor = nextRef(this.#cursor);
    const entry = { clientRef: this.#cursor, update, oversized, held: false, sentSerial: 0, retries: 0 };
    this.#entries.set(entry.clientRef, entry);
    this.#cursor = nextRef(this.#cursor);
    return entry;
  }

  get(clientRef) { return this.#entries.get(clientRef); }

  /** Removes the entry the relay acknowledged; false when it is not (or no longer) pending. */
  acknowledge(clientRef) { return this.#entries.delete(clientRef); }

  /** Removes entries an accepted snapshot already holds. */
  removeAll(clientRefs) {
    for (const clientRef of clientRefs) this.#entries.delete(clientRef);
  }

  refs() { return [...this.#entries.keys()]; }

  /** Entries in creation order. */
  list() { return [...this.#entries.values()]; }

  hasOversized() { return this.list().some((entry) => entry.oversized); }
}
