import { useEffect, useRef, useState } from 'react';

export const ZONE_TOOLS_EXIT_DURATION_MS = 180;
export const ZONE_POPUP_MOTION_DURATION_MS = 160;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const browserScheduler = {
  frame: (callback) => ({ frame: requestAnimationFrame(callback) }),
  timeout: (callback, delayMs) => ({ timeout: setTimeout(callback, delayMs) }),
  cancel: (job) => {
    if (job.frame !== undefined) cancelAnimationFrame(job.frame);
    else clearTimeout(job.timeout);
  },
};

// Two frames let the entering element paint before transitioning to open.
export function schedulePresence(open, reducedMotion, notify, scheduler = browserScheduler) {
  let job;
  if (reducedMotion) notify(open ? 'open' : null);
  else if (open) {
    notify('enter');
    job = scheduler.frame(() => {
      job = scheduler.frame(() => notify('open'));
    });
  } else {
    notify('exit');
    job = scheduler.timeout(() => notify(null), ZONE_TOOLS_EXIT_DURATION_MS);
  }
  return () => { if (job !== undefined) scheduler.cancel(job); };
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => globalThis.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false);
  useEffect(() => {
    const media = globalThis.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function usePresence(open) {
  const reduced = useReducedMotion();
  const [state, setState] = useState(open ? 'enter' : null);
  const mountedRef = useRef(open);
  useEffect(() => {
    if (!open && !mountedRef.current) return;
    return schedulePresence(open, reduced, (nextState) => {
      mountedRef.current = nextState !== null;
      setState(nextState);
    });
  }, [open, reduced]);
  const reducedState = open ? 'open' : null;
  const visibleState = reduced ? reducedState : state;
  return { mounted: visibleState !== null, state: visibleState };
}
