import { WebsocketProvider } from 'y-websocket';
import { isRoomDeletedClose, pageRoomDeleted } from './room-deleted.js';

/**
 * y-websocket for a plain room, ended for good by the relay's room-deleted close: that close marks the page's
 * deleted state, which disconnects it, and connect() then does nothing. Disconnecting inside the close event
 * also turns y-websocket's own scheduled reconnect into a no-op.
 */
export class PlainRoomProvider extends WebsocketProvider {
  #roomDeleted;
  #offRoomDeleted;

  constructor(serverUrl, roomname, doc, { roomDeleted = pageRoomDeleted, connect = true, ...options } = {}) {
    super(serverUrl, roomname, doc, { ...options, connect: false });
    this.#roomDeleted = roomDeleted;
    this.#offRoomDeleted = roomDeleted.subscribe(() => this.disconnect());
    this.on('connection-close', (event) => { if (isRoomDeletedClose(event)) roomDeleted.mark(); });
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
}
