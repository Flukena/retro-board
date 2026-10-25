import { useEffect, useState } from 'react';
import { settledCardRenderState } from '../../domain/viewport-limits.js';

const VIEWPORT_SETTLE_CHECK_INTERVAL_MS = 120;

export function scheduleSettledViewport(liveViewportRef, interactionRefs, commit, scheduler = globalThis) {
  let timer = null;
  const settle = () => {
    if (interactionRefs.some(ref => ref.current != null)) {
      timer = scheduler.setTimeout(settle, VIEWPORT_SETTLE_CHECK_INTERVAL_MS);
      return;
    }
    commit(liveViewportRef.current);
  };
  settle();
  return () => { if (timer !== null) scheduler.clearTimeout(timer); };
}

export function useSettledViewport(viewport, liveViewportRef, interactionRef, wheelCommitRef, wheelFrameRef) {
  const [settled, setSettled] = useState(viewport);
  useEffect(() => scheduleSettledViewport(liveViewportRef, [interactionRef, wheelCommitRef, wheelFrameRef], setSettled),
    [viewport, liveViewportRef, interactionRef, wheelCommitRef, wheelFrameRef]);
  return settledCardRenderState(settled);
}
