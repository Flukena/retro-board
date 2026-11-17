// At most one reaction per interval per person. Clicks inside the interval are dropped, not queued.
export const REACTION_SEND_INTERVAL_MS = 1000;

export class ReactionRateLimiter {
  #intervalMs;
  #lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(intervalMs = REACTION_SEND_INTERVAL_MS) {
    this.#intervalMs = intervalMs;
  }

  /** How long until the next send is allowed; a clock that stepped back counts as elapsed. */
  remainingMs(now) {
    const elapsed = now - this.#lastSentAt;
    return elapsed < 0 ? 0 : Math.max(0, this.#intervalMs - elapsed);
  }

  /** True, and the interval restarts, when a send at `now` is allowed. */
  tryTake(now) {
    if (this.remainingMs(now) > 0) return false;
    this.#lastSentAt = now;
    return true;
  }
}
