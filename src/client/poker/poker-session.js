// Live connection for one Planning Poker room. Must be opened only after
// establishRoomSession() has set the room cookie (see PokerBootstrap).
// Unlike storage-bridge.js it has no import-time side effects.
import * as Y from 'yjs';
import { getActiveRoomSession, getRoomWebSocketBaseUrl, refreshActiveRoomSession } from '../session/room-session.js';
import { attachClientSync } from '../session/client-sync.js';
import { PlainRoomProvider } from '../session/plain-room-provider.js';
import { sendOnlyLocalAwareness } from '../session/awareness-transport.js';
import { POKER_SHARED_MAP_NAMES, createStoryUndoManager } from './poker-actions.js';

export function openPokerRoom({ browser = window, Provider = PlainRoomProvider } = {}) {
  const session = getActiveRoomSession();
  if (!session) throw new Error('room session has not been established');
  const doc = new Y.Doc();
  // The room name is the opaque session handle, never the link capability.
  const provider = new Provider(getRoomWebSocketBaseUrl(), session.roomHandle, doc, {
    connect: false,
    probeSession: refreshActiveRoomSession,
    // Binds the relay connection to this awareness identity (not a credential).
    params: { awarenessId: String(doc.clientID) },
  });
  sendOnlyLocalAwareness(provider);
  provider.connect();
  const syncStatus = attachClientSync(provider, doc, browser, { sharedMapNames: POKER_SHARED_MAP_NAMES });
  const undoManager = createStoryUndoManager(doc);
  return {
    doc,
    awareness: provider.awareness,
    syncStatus,
    undoManager,
    destroy() {
      undoManager.destroy();
      provider.destroy();
      doc.destroy();
    },
  };
}
