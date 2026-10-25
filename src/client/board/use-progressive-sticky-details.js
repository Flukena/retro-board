import { useEffect, useState } from 'react';
import { nextStickyDetailBatch } from '../../domain/board-render-visibility.js';

const EMPTY_DETAILS = new Set();

export function scheduleStickyDetailBatch(current, target, interactionRefs, commit, view = globalThis) {
  const next = nextStickyDetailBatch(current, target);
  if (next === current) return () => {};
  if (target === null) { commit(null); return () => {}; }
  let frame = null;
  const hydrate = () => {
    frame = null;
    if (interactionRefs.some(ref => ref.current != null)) {
      frame = view.requestAnimationFrame(hydrate);
      return;
    }
    commit(next);
  };
  frame = view.requestAnimationFrame(hydrate);
  return () => { if (frame !== null) view.cancelAnimationFrame(frame); };
}

export function useProgressiveStickyDetails(target, interactionRef, wheelCommitRef, wheelFrameRef) {
  const [details, setDetails] = useState(null);
  useEffect(() => scheduleStickyDetailBatch(details, target, [interactionRef, wheelCommitRef, wheelFrameRef], setDetails),
    [details, target, interactionRef, wheelCommitRef, wheelFrameRef]);
  return target === null ? null : details ?? EMPTY_DETAILS;
}
