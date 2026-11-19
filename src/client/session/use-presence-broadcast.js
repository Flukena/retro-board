import { useCallback, useRef } from 'react';
import { createLatestThrottle } from './latest-throttle.js';
import { playerViewFromViewport } from './player-cursors.js';
import { CURSOR_BROADCAST_MS } from '../board/cursor-timing.js';

const VIEW_POSITION_EPSILON_PX = 0.05;
const VIEW_ZOOM_EPSILON = 0.0001;

function samePublishedView(previous, view) {
  return previous
    && Math.abs(previous.x - view.x) < VIEW_POSITION_EPSILON_PX
    && Math.abs(previous.y - view.y) < VIEW_POSITION_EPSILON_PX
    && Math.abs(previous.zoom - view.zoom) < VIEW_ZOOM_EPSILON;
}

export function createPresenceBroadcast({ getStorage = () => globalThis.window?.storage, clock } = {}) {
  let lastPublishedView = null;
  const cursor = createLatestThrottle({
    intervalMs: CURSOR_BROADCAST_MS, clock,
    publish: (point) => {
      const storage = getStorage();
      storage?.setLocalCursor?.(point);
    },
  });
  const view = createLatestThrottle({
    intervalMs: CURSOR_BROADCAST_MS, clock,
    publish: (value) => {
      if (value) lastPublishedView = value;
      const storage = getStorage();
      storage?.setLocalView?.(value);
    },
  });
  return {
    publishLocalCursor: cursor.push,
    clearLocalCursor: cursor.clear,
    publishLocalView: (viewportValue, viewportSize) => {
      const next = playerViewFromViewport(viewportValue, viewportSize);
      if (!next) return;
      if (samePublishedView(lastPublishedView, next)) { view.cancel(); return; }
      view.push(next);
    },
    cancel: () => { cursor.cancel(); view.cancel(); },
    dispose: () => { cursor.dispose(); view.dispose(); },
  };
}

export function usePresenceBroadcastState() {
  const broadcastRef = useRef(null);
  if (!broadcastRef.current) broadcastRef.current = createPresenceBroadcast();
  return broadcastRef;
}

export function usePresenceBroadcast(broadcastRef, viewportSize) {
  const publishLocalCursor = useCallback((point) => broadcastRef.current.publishLocalCursor(point), []);
  const clearLocalCursor = useCallback(() => broadcastRef.current.clearLocalCursor(), []);
  const publishLocalView = useCallback((value) => broadcastRef.current.publishLocalView(value, viewportSize), [viewportSize]);
  return { publishLocalCursor, clearLocalCursor, publishLocalView };
}
