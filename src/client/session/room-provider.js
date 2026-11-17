import { E2EProvider } from './e2e-provider.js';
import { PlainRoomProvider } from './plain-room-provider.js';

/** True when this page holds the unlocked key of exactly this room. */
export const isEncryptedRoom = (roomKey, roomHandle) => roomKey?.roomHandle === roomHandle;

/**
 * The one place a board picks its transport: the unlocked key of this very room selects the encrypted provider;
 * every other room keeps the y-websocket provider with its existing options. `probeSession` is for private rooms only.
 */
export function createRoomProvider({ wsBaseUrl, roomHandle, ydoc, params, roomKey, probeSession = null }) {
  if (isEncryptedRoom(roomKey, roomHandle)) return new E2EProvider(wsBaseUrl, roomHandle, ydoc, { key: roomKey, connect: false });
  return new PlainRoomProvider(wsBaseUrl, roomHandle, ydoc, { connect: false, params, probeSession });
}
