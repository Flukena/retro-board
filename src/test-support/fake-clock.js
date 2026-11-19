// Deterministic monotonic timers. Arrow methods are safe to inject without binding.
export function createFakeClock(startMs = 0) {
  let nowMs = startMs;
  let nextId = 0;
  const timers = new Map();
  const clock = {
    now: () => nowMs,
    setTimeout: (run, delayMs) => {
      const id = ++nextId;
      timers.set(id, { run, atMs: nowMs + Math.max(0, delayMs) });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    pendingCount: () => timers.size,
    advance: (elapsedMs) => {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError('Clock advances must be finite and nonnegative');
      const endMs = nowMs + elapsedMs;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.atMs <= endMs)
          .sort((a, b) => a[1].atMs - b[1].atMs || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        nowMs = timer.atMs;
        timer.run();
      }
      nowMs = endMs;
    },
  };
  return clock;
}
