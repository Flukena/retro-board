const HOST_CLOCK = Object.freeze({
  now: () => globalThis.performance.now(),
  setTimeout: (run, delayMs) => globalThis.setTimeout(run, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
});

export function createLatestThrottle({ intervalMs, publish, clock = HOST_CLOCK }) {
  let lastSentAtMs = 0;
  let pending = null;
  let timer = null;
  const cancel = () => {
    pending = null;
    if (timer != null) clock.clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    timer = null;
    const value = pending;
    pending = null;
    if (!value) return;
    lastSentAtMs = clock.now();
    publish(value);
  };
  const push = (value) => {
    pending = value;
    const elapsedMs = clock.now() - lastSentAtMs;
    if (elapsedMs >= intervalMs) {
      if (timer != null) clock.clearTimeout(timer);
      flush();
      return;
    }
    if (timer == null) timer = clock.setTimeout(flush, intervalMs - elapsedMs);
  };
  const clear = () => { cancel(); publish(null); };
  return { push, cancel, clear, dispose: clear };
}
