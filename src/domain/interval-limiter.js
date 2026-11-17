// At most `maxPerInterval` takes within any `intervalMs` window; extra attempts are dropped, never queued. Shared by
// the board-reaction send and playback limits and the Planning Poker reaction cooldown, each with its own interval.
// The caller supplies the time. A clock that steps backwards (a wall-clock correction) counts as elapsed: the
// window restarts from the new time, so a correction never locks anyone out and costs at most one extra take.
export class IntervalLimiter {
  #intervalMs;
  #maxPerInterval;
  // Times of the takes still inside the window, oldest first; never longer than #maxPerInterval.
  #takenAt = [];

  constructor(intervalMs, maxPerInterval = 1) {
    this.#intervalMs = intervalMs;
    this.#maxPerInterval = maxPerInterval;
  }

  #takesInWindow(now) {
    const newest = this.#takenAt.at(-1);
    if (newest !== undefined && now < newest) return [];
    return this.#takenAt.filter((takenAt) => now - takenAt < this.#intervalMs);
  }

  /** How long until a take at `now` would be allowed; 0 when it would be. Changes nothing. */
  remainingMs(now) {
    const takes = this.#takesInWindow(now);
    return takes.length < this.#maxPerInterval ? 0 : takes[0] + this.#intervalMs - now;
  }

  /** True, and the take is counted, when one more fits in the window at `now`. */
  tryTake(now) {
    const takes = this.#takesInWindow(now);
    if (takes.length >= this.#maxPerInterval) return false;
    this.#takenAt = [...takes, now];
    return true;
  }
}
