import * as Y from 'yjs';
import { ROOM_KEY_CHANGED_EVENT } from '../room-lock/lock-session.js';
import { attachE2EVoteExpiry } from './e2e-vote-expiry.js';

/**
 * Board wiring that only encrypted rooms need: a re-unlock hands the provider the new key (pending edits are
 * re-sent under it), a new key epoch clears undo/redo so it cannot resurrect old references (Deviation 8),
 * vote timers expire on the clients, and the rotation flow gets the document state without the document.
 */
export function attachE2ERoom({ provider, ydoc, eventTarget, getRoomKey, clearUndo }) {
  const onKeyChanged = (event) => {
    const key = getRoomKey();
    if (key?.roomHandle !== provider.roomname) return;
    if (event.detail?.epochChanged) clearUndo();
    provider.setKey(key);
  };
  eventTarget.addEventListener(ROOM_KEY_CHANGED_EVENT, onKeyChanged);
  const expiry = attachE2EVoteExpiry({ ydoc, provider });
  ydoc.on('destroy', () => {
    eventTarget.removeEventListener(ROOM_KEY_CHANGED_EVENT, onKeyChanged);
    expiry.destroy();
  });
  return {
    /**
     * For the key rotation (Task 14): the current state, never the live doc, plus how far this page has read the
     * log. The commit must claim `appliedSnapshotBase` (the relay refuses it otherwise) and waits for
     * `appliedSeq === head` and `pendingDelivery === 0` before capturing.
     */
    rotationSource: () => ({
      encodeState: () => Y.encodeStateAsUpdate(ydoc),
      roomHandle: provider.roomname,
      keyEpoch: getRoomKey()?.keyEpoch,
      appliedSeq: provider.appliedSeq,
      head: provider.head,
      appliedSnapshotBase: provider.appliedSnapshotBase,
      pendingDelivery: provider.pendingDelivery,
    }),
  };
}
