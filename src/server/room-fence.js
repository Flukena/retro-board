/**
 * One per relay. Every operation that can write a room's state or files holds an entry for its whole duration;
 * deletion fences the room (new entries are refused) and waits until the held ones are released.
 * A fenced room stays fenced until its deletion completes and the deleter lifts it.
 */
export class RoomFence {
  #entries = new Map();
  #fenced = new Set();
  #waiters = new Map();

  /** A release function (safe to call twice), or null once the room is fenced. */
  enter(docName) {
    if (this.#fenced.has(docName)) return null;
    this.#entries.set(docName, (this.#entries.get(docName) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#leave(docName);
    };
  }

  #leave(docName) {
    const left = this.#entries.get(docName) - 1;
    if (left > 0) {
      this.#entries.set(docName, left);
      return;
    }
    this.#entries.delete(docName);
    const waiters = this.#waiters.get(docName) ?? [];
    this.#waiters.delete(docName);
    waiters.forEach((wake) => wake());
  }

  fence(docName) { this.#fenced.add(docName); }

  isFenced(docName) { return this.#fenced.has(docName); }

  lift(docName) { this.#fenced.delete(docName); }

  /** True once no entry is held; false when one is still held after `timeoutMs`. */
  drained(docName, timeoutMs) {
    if (!this.#entries.has(docName)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(docName) ?? new Set();
      this.#waiters.set(docName, waiters);
      const timer = setTimeout(() => {
        waiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      function wake() {
        clearTimeout(timer);
        resolve(true);
      }
      waiters.add(wake);
    });
  }
}

/** A fence that never refuses: for components serving a room that is never deleted, and for tests of other concerns. */
export const UNFENCED = Object.freeze({ enter: () => () => {}, isFenced: () => false });
