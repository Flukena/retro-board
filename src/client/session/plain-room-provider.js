import { WebsocketProvider } from 'y-websocket';
import { isRoomDeletedClose, pageRoomDeleted } from './room-deleted.js';

/** Consecutive refused upgrades of a private room before one session renewal checks whether the room was deleted. */
export const FAILED_UPGRADES_BEFORE_PROBE = 3;
const ROOM_GONE_STATUS = 404;
const CONNECTED_STATUS = 'connected';

/**
 * y-websocket for a plain room, ended for good by the relay's room-deleted close: that close marks the page's
 * deleted state, which disconnects it, and connect() then does nothing. Disconnecting inside the close event
 * also turns y-websocket's own scheduled reconnect into a no-op.
 *
 * A page that missed the close (offline at deletion) only sees refused upgrades, which y-websocket retries
 * forever. With `probeSession` (private rooms only), a run of refused upgrades renews the session once; a 404
 * means the room was deleted. Any other outcome leaves y-websocket retrying.
 */
export class PlainRoomProvider extends WebsocketProvider {
  #roomDeleted;
  #offRoomDeleted;
  #probeSession;
  #failedUpgrades = 0;
  #probing = false;

  constructor(serverUrl, roomname, doc, {
    roomDeleted = pageRoomDeleted, probeSession = null, connect = true, ...options
  } = {}) {
    super(serverUrl, roomname, doc, { ...options, connect: false });
    this.#roomDeleted = roomDeleted;
    this.#probeSession = probeSession;
    this.#offRoomDeleted = roomDeleted.subscribe(() => this.disconnect());
    this.on('status', ({ status }) => { if (status === CONNECTED_STATUS) this.#failedUpgrades = 0; });
    this.on('connection-close', (event) => this.#onClose(event));
    if (connect) this.connect();
  }

  connect() {
    if (this.#roomDeleted.isDeleted()) return;
    super.connect();
  }

  destroy() {
    this.#offRoomDeleted();
    super.destroy();
  }

  // y-websocket emits the close before it resets wsconnected, so a close while not connected is a refused upgrade.
  #onClose(event) {
    if (isRoomDeletedClose(event)) {
      this.#roomDeleted.mark();
      return;
    }
    if (this.wsconnected || this.#probeSession === null) return;
    this.#failedUpgrades += 1;
    if (this.#failedUpgrades >= FAILED_UPGRADES_BEFORE_PROBE && !this.#probing) this.#probe();
  }

  #probe() {
    this.#probing = true;
    this.#probeSession()
      .catch((error) => { if (error?.httpStatus === ROOM_GONE_STATUS) this.#roomDeleted.mark(); })
      .finally(() => {
        this.#probing = false;
        this.#failedUpgrades = 0;
      });
  }
}
