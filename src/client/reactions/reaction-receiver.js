import { BOARD_REACTION_FIELD, decodeBoardReaction } from '../../domain/board-reactions.js';

// Sender clocks are compared with ours, so the window is generous: the same 10 s that cursors tolerate. Sequence
// numbers and the first-sight baseline below are what stop replays; this only drops sends that arrive very late,
// such as messages queued while this tab was frozen in the background.
export const REACTION_STALE_MS = 10_000;
const NO_REACTION_SEQ = 0;

const reactionOf = (states, clientId) => states.get(clientId)?.[BOARD_REACTION_FIELD];

/**
 * Decides which presence reactions to play, each exactly once. Per sender it keeps the highest seq seen. Whatever a
 * sender carries when this page first sees it (joining, or the sender reconnecting) counts as already seen.
 */
export class ReactionReceiver {
  #lastSeq = new Map();
  #staleMs;

  constructor(staleMs = REACTION_STALE_MS) {
    this.#staleMs = staleMs;
  }

  /** Every state present when the page starts listening counts as already seen. */
  seed(states) {
    states.forEach((state, clientId) => this.#baseline(clientId, state?.[BOARD_REACTION_FIELD]));
  }

  /** Applies one awareness `change`; returns the reactions to play as `{ clientId, reaction, state }`. */
  receive({ added, updated, removed }, states, now) {
    removed.forEach((clientId) => this.#lastSeq.delete(clientId));
    const plays = [];
    for (const clientId of [...added, ...updated]) {
      const raw = reactionOf(states, clientId);
      if (!this.#lastSeq.has(clientId)) {
        this.#baseline(clientId, raw);
        continue;
      }
      const reaction = this.#accept(clientId, raw, now);
      if (reaction) plays.push({ clientId, reaction, state: states.get(clientId) });
    }
    return plays;
  }

  #baseline(clientId, raw) {
    this.#lastSeq.set(clientId, decodeBoardReaction(raw)?.seq ?? NO_REACTION_SEQ);
  }

  #accept(clientId, raw, now) {
    const reaction = decodeBoardReaction(raw);
    if (!reaction || reaction.seq <= this.#lastSeq.get(clientId)) return null;
    this.#lastSeq.set(clientId, reaction.seq);
    return now - reaction.at > this.#staleMs ? null : reaction;
  }
}
