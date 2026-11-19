import { getRoomKey } from '../../room-lock/lock-session.js';
import { isEncryptedRoom } from '../room-provider.js';
import { uploadEncryptedImage } from '../../room-lock/e2e-images.js';
import { listImageSources, rewriteImageSources } from '../item-image-sources.js';
import { normalizeRuntimeImageSource } from '../../../domain/security-boundaries.js';
import { getRelayHttpBaseUrl, roomFetch } from '../room-session.js';
import { IMAGE_REPAIR_ORIGIN } from './snapshot-doc.js';

export function createRoomMethods({ provider, syncStatus, activeRoomSession, ydoc, yItems, yMeta }) {
  return {
    images: {
      // Uploads an image blob to the server and resolves to its served URL.
      async uploadImage(blob, { signal } = {}) {
        // An encrypted room never sends image bytes in the clear: encrypt here, the one boundary every upload path shares.
        const key = getRoomKey();
        if (isEncryptedRoom(key, activeRoomSession.roomHandle)) return uploadEncryptedImage(blob, { signal, key });
        const res = await roomFetch('upload', {
          signal,
          method: 'POST',
          body: blob,
          headers: { 'Content-Type': blob.type },
        });
        if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
        const payload = await res.json();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || Object.keys(payload).length !== 1 || typeof payload.url !== 'string') {
          throw new Error('invalid image upload response');
        }
        const url = normalizeRuntimeImageSource(payload.url, {
          pageOrigin: window.location.origin,
          relayBaseUrl: getRelayHttpBaseUrl(),
          roomHandle: activeRoomSession.roomHandle,
        });
        if (!url) throw new Error('invalid image upload URL');
        return url;
      },

      // Image sources of the live board, and the one local transaction that image repair rewrites them in.
      listImageSources() { return listImageSources(yItems); },
      rewriteImageSources(replacements) {
        if (!isEncryptedRoom(getRoomKey(), activeRoomSession.roomHandle)) throw new RangeError('image rewrite is for locked rooms');
        return rewriteImageSources(ydoc, yItems, replacements, IMAGE_REPAIR_ORIGIN, activeRoomSession.roomHandle);
      },

    },
    sync: {
      // True once the WebSocket has finished its initial state exchange with
      // the server. RetroBoard gates admin election on this so a returning
      // client doesn't claim the role during cold start before learning who
      // the real current admin is — split-brain prevention.
      synced() { return !!(provider && provider.synced); },
      getSyncStatus: syncStatus.getSnapshot,
      onSyncStatus: syncStatus.subscribe,
      // Read the live admin userId straight from yMeta, bypassing the React
      // render queue. boardRef.current updates only after applyRemoteBoard
      // runs AND React re-renders — there's a tick of lag in between, and a
      // heartbeat firing inside that gap could see the stale DEFAULT_BOARD
      // null and try to re-claim admin even though the room already has one.
      getAdminUserId() { return yMeta.get('adminUserId') || null; },
      // Fire when the initial WebSocket exchange completes (idempotent — if
      // sync already happened, the callback fires immediately on next tick).
      onSynced(handler) {
        if (!provider) return () => {};
        if (provider.synced) {
          const t = setTimeout(handler, 0);
          return () => clearTimeout(t);
        }
        const wrapped = (isSynced) => { if (isSynced) handler(); };
        provider.on('sync', wrapped);
        return () => provider.off('sync', wrapped);
      },
    },
  };
}
