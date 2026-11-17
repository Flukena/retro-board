import { BOARD_REACTION_FIELD, decodeBoardReaction } from '../../domain/board-reactions.js';
import { IntervalLimiter } from '../../domain/interval-limiter.js';

// Every sender together plays at most this many reactions per window on this page, so a peer cycling through many
// presence identities cannot flood the screen. Twelve matches the most floats shown at once.
export const MAX_PLAYS_PER_ADMISSION_WINDOW = 12;
export const REACTION_ADMISSION_WINDOW_MS = 1000;
// Each sender plays at most once per this interval on this page. It stays below REACTION_SEND_INTERVAL_MS so two
// honest sends a second apart still both play when relay coalescing or network jitter brings them closer; a peer that
// skips its own limit is held to 1.25 a second, and the shared budget above still applies.
export const REACTION_PLAY_INTERVAL_MS = 800;
const NO_REACTION_SEQ = 0;

const reactionOf = (states, clientId) => states.get(clientId)?.[BOARD_REACTION_FIELD];

/**
 * Decides which presence reactions this page plays. Per sender it keeps the highest seq seen: a higher seq is consumed
 * whether or not it plays, so nothing replays later. Whatever a sender carries when this page first sees it (joining,
 * or the sender reconnecting) counts as already seen. Playback is limited on this page's own clock, never a sender's:
 * one play per sender per play interval, and a shared budget across all senders.
 */
export class ReactionReceiver {
  #lastSeq = new Map();
  // Senders that played within the last interval. Kept across leave/rejoin so reconnecting cannot skip the wait;
  // only real plays add entries, so the shared budget bounds its size.
  #cooldowns = new Map();
  #admission = new IntervalLimiter(REACTION_ADMISSION_WINDOW_MS, MAX_PLAYS_PER_ADMISSION_WINDOW);

  /** Every state present when the page starts listening counts as already seen. */
  seed(states) {
    states.forEach((state, clientId) => this.#baseline(clientId, state?.[BOARD_REACTION_FIELD]));
  }

  /** Applies one awareness `change` at this page's time `now`; returns the plays as `{ clientId, reaction, state }`. */
  receive({ added, updated, removed }, states, now) {
    removed.forEach((clientId) => this.#lastSeq.delete(clientId));
    const plays = [];
    for (const clientId of [...added, ...updated]) {
      const raw = reactionOf(states, clientId);
      if (!this.#lastSeq.has(clientId)) {
        this.#baseline(clientId, raw);
        continue;
      }
      const reaction = this.#consume(clientId, raw);
      if (reaction && this.#admit(clientId, now)) plays.push({ clientId, reaction, state: states.get(clientId) });
    }
    return plays;
  }

  #baseline(clientId, raw) {
    this.#lastSeq.set(clientId, decodeBoardReaction(raw)?.seq ?? NO_REACTION_SEQ);
  }

  /** The sender's next reaction, if `raw` is one; its seq is used up either way. */
  #consume(clientId, raw) {
    const reaction = decodeBoardReaction(raw);
    if (!reaction || reaction.seq <= this.#lastSeq.get(clientId)) return null;
    this.#lastSeq.set(clientId, reaction.seq);
    return reaction;
  }

  /** The sender's own wait first, so one busy sender cannot spend the shared budget; then the budget. */
  #admit(clientId, now) {
    this.#forgetCooledDown(now);
    const cooldown = this.#cooldowns.get(clientId) ?? new IntervalLimiter(REACTION_PLAY_INTERVAL_MS);
    if (cooldown.remainingMs(now) > 0 || !this.#admission.tryTake(now)) return false;
    cooldown.tryTake(now);
    this.#cooldowns.set(clientId, cooldown);
    return true;
  }

  #forgetCooledDown(now) {
    this.#cooldowns.forEach((cooldown, clientId) => {
      if (cooldown.remainingMs(now) === 0) this.#cooldowns.delete(clientId);
    });
  }
}
