export const SYNC_STATE = Object.freeze({
  CONNECTED: 'connected', CONNECTING: 'connecting', DISCONNECTED: 'disconnected', SESSION_LOST: 'session-lost', ACTION_LIMIT: 'action-limit',
  // Connected, but some local edits are not acknowledged by the relay yet (encrypted rooms).
  SAVING: 'saving',
});

export class SyncStatus {
  #listeners = new Set();
  #transport = SYNC_STATE.CONNECTING;
  #sessionLost = false;
  #socketExpired = false;
  #actionLimited = false;
  #pending = false;
  #pendingDelivery = 0;
  #snapshot = Object.freeze({ status: SYNC_STATE.CONNECTING, hasUnsyncedLocalChanges: false });

  getSnapshot = () => this.#snapshot;
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #status() {
    if (this.#actionLimited) return SYNC_STATE.ACTION_LIMIT;
    if (this.#sessionLost || this.#socketExpired) return SYNC_STATE.SESSION_LOST;
    if (this.#transport === SYNC_STATE.CONNECTED && this.#pendingDelivery > 0) return SYNC_STATE.SAVING;
    return this.#transport;
  }

  #publish() {
    const status = this.#status();
    const unsynced = this.#pending || this.#pendingDelivery > 0;
    if (this.#snapshot.status === status && this.#snapshot.hasUnsyncedLocalChanges === unsynced) return;
    this.#snapshot = Object.freeze({ status, hasUnsyncedLocalChanges: unsynced });
    this.#listeners.forEach((listener) => listener());
  }

  transport(status) {
    if (status === SYNC_STATE.CONNECTED) return; // Wait for the WebSocket state exchange.
    // Reconnect attempts must not make an ongoing outage banner flicker.
    if (status === SYNC_STATE.CONNECTING && this.#transport === SYNC_STATE.DISCONNECTED) return;
    this.#transport = status;
    this.#publish();
  }

  sessionLost(lost) {
    this.#sessionLost = lost;
    this.#publish();
  }

  socketExpired() {
    this.#socketExpired = true;
    this.#publish();
  }

  actionLimitReached() {
    this.#actionLimited = true;
    this.#pending = true;
    this.#publish();
  }

  localChange(socketSynced) {
    if (socketSynced && !this.#sessionLost && !this.#socketExpired) return;
    this.#pending = true;
    this.#publish();
  }

  /** Local edits the relay has not acknowledged; only providers with acknowledged delivery report it. */
  delivery(pendingCount) {
    this.#pendingDelivery = pendingCount;
    this.#publish();
  }

  synced(socketConnected) {
    if (!socketConnected || this.#actionLimited) return; // BroadcastChannel is not a relay acknowledgement.
    // A replacement socket authenticated successfully. HTTP refresh failure,
    // if any, remains separate until the session service reports recovery.
    this.#socketExpired = false;
    this.#transport = SYNC_STATE.CONNECTED;
    this.#pending = false;
    this.#publish();
  }
}

export const shouldGuardUnload = (state) => (
  state.status !== SYNC_STATE.CONNECTED && state.hasUnsyncedLocalChanges
);
