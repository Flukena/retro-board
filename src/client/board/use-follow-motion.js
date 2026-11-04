import { useEffect } from 'react';
import { centerViewportOnWorld } from '../../domain/minimap.js';
import { PLAYER_CURSOR_STALE_MS } from '../session/player-cursors.js';

const hasViewCenter = (player) => Number.isFinite(player?.view?.x) && Number.isFinite(player?.view?.y);

/** De-duplication key for one motion sample of the followed player, or null when there is nothing to follow. */
export function followMotionSignature(targetId, player) {
  if (hasViewCenter(player)) return `${targetId}:view:${player.view.updatedAt || 0}`;
  return player?.cursor ? `${targetId}:cursor:${player.cursor.updatedAt || 0}` : null;
}

/**
 * Viewport that centres on the followed player's view (or, for old clients,
 * a fresh cursor), keeping their zoom when they publish one.
 */
export function followMotionViewport(player, viewport, viewportSize, now) {
  const viewCenter = hasViewCenter(player);
  const targetPoint = viewCenter ? player.view : player?.cursor;
  if (!targetPoint) return null;
  if (!viewCenter && now - Number(player.cursor?.updatedAt || 0) >= PLAYER_CURSOR_STALE_MS) return null;
  return centerViewportOnWorld({ ...viewport, zoom: player.view?.zoom || viewport.zoom }, viewportSize, targetPoint);
}

// Awareness motion reaches this listener before the React presence update.
// Apply the newest target viewport on the next paint so a busy board cannot
// make Follow wait for a full component render.
export function useFollowMotion({ storage, followedUserId, refs, viewportSize, liveApplyViewport }) {
  useEffect(() => {
    if (!followedUserId) return undefined;
    const { followedUserIdRef, playerRef, frameRef, signatureRef, viewportRef } = refs;
    const applyLatest = () => {
      frameRef.current = null;
      const player = playerRef.current;
      playerRef.current = null;
      if (!followedUserIdRef.current || !player) return;
      const next = followMotionViewport(player, viewportRef.current, viewportSize, Date.now());
      if (next) liveApplyViewport(next, { broadcastView: false });
    };
    const onPresenceChange = (event) => {
      const targetId = followedUserIdRef.current;
      const player = targetId ? event?.detail?.[targetId] : null;
      const signature = followMotionSignature(targetId, player);
      if (!signature || signature === signatureRef.current) return;
      signatureRef.current = signature;
      playerRef.current = player;
      if (frameRef.current == null) frameRef.current = requestAnimationFrame(applyLatest);
    };
    const unsubscribe = storage.onPresenceChange(onPresenceChange);
    onPresenceChange({ detail: storage.getPresenceSnapshot() });
    return () => {
      unsubscribe?.();
      playerRef.current = null;
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [storage, followedUserId, refs, viewportSize, liveApplyViewport]);
}
