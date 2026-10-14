export const SYNC_STATE = Object.freeze({
  CONNECTED: 'connected', CONNECTING: 'connecting', DISCONNECTED: 'disconnected', SESSION_LOST: 'session-lost',
});

export class SyncStatus {
  #listeners = new Set();
  #transport = SYNC_STATE.CONNECTING;
  #sessionLost = false;
  #pending = false;
  #snapshot = Object.freeze({ status: SYNC_STATE.CONNECTING, hasUnsyncedLocalChanges: false });

  getSnapshot = () => this.#snapshot;
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #publish() {
    const status = this.#sessionLost ? SYNC_STATE.SESSION_LOST : this.#transport;
    if (this.#snapshot.status === status && this.#snapshot.hasUnsyncedLocalChanges === this.#pending) return;
    this.#snapshot = Object.freeze({ status, hasUnsyncedLocalChanges: this.#pending });
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

  localChange(socketSynced) {
    if (socketSynced && !this.#sessionLost) return;
    this.#pending = true;
    this.#publish();
  }

  synced(socketConnected) {
    if (!socketConnected) return; // BroadcastChannel is not a relay acknowledgement.
    this.#transport = SYNC_STATE.CONNECTED;
    this.#pending = false;
    this.#publish();
  }
}

export const shouldGuardUnload = (state) => (
  state.status !== SYNC_STATE.CONNECTED && state.hasUnsyncedLocalChanges
);
