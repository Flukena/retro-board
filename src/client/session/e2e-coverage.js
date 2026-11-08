/**
 * Which log seqs this page holds. `appliedSeq` is the highest seq with every seq at or below it applied:
 * from an UPDATE, a snapshot's baseSeq, or the ACK of this page's own append (its content is already local).
 * A seq that failed to decrypt or apply still counts as passed, but is remembered in `skippedSeq`.
 */
export class SeqCoverage {
  #applied = 0;
  #head = 0;
  #ahead = new Set();
  #skippedSeq = null;

  get appliedSeq() { return this.#applied; }
  get head() { return this.#head; }
  get skippedSeq() { return this.#skippedSeq; }
  get caughtUp() { return this.#applied === this.#head; }

  /** A new connection replays the log from its snapshot, so coverage is rebuilt from the replay. */
  restart() {
    this.#applied = 0;
    this.#head = 0;
    this.#ahead.clear();
  }

  noteHead(seq) {
    this.#head = Math.max(this.#head, seq);
  }

  cover(seq) {
    this.noteHead(seq);
    if (seq <= this.#applied) return;
    this.#ahead.add(seq);
    this.#advance();
  }

  skip(seq) {
    this.#skippedSeq ??= seq;
    this.cover(seq);
  }

  /** A snapshot holds every seq up to its baseSeq. */
  coverThrough(baseSeq) {
    this.noteHead(baseSeq);
    if (baseSeq <= this.#applied) return;
    this.#applied = baseSeq;
    for (const seq of this.#ahead) if (seq <= baseSeq) this.#ahead.delete(seq);
    this.#advance();
  }

  #advance() {
    while (this.#ahead.delete(this.#applied + 1)) this.#applied += 1;
  }
}
