// Board reactions over Yjs awareness: ephemeral, relayed like cursors, and encrypted on locked boards by the E2E
// provider's presence path. Nothing touches the board document, so nothing is stored or undoable.
import {
  BOARD_REACTIONS, BOARD_REACTION_FIELD, REACTION_SEND_INTERVAL_MS, boardReaction,
} from '../../domain/board-reactions.js';
import { IntervalLimiter } from '../../domain/interval-limiter.js';
import { DISPLAY_NAME_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { ReactionReceiver } from './reaction-receiver.js';

// How long a sent reaction stays in presence before the sender clears it: well past the relay's 50 ms fan-out
// window and an E2E encrypt/decrypt round, yet short enough that a reconnecting peer rarely sees it.
export const REACTION_CLEAR_MS = 3000;

/** The sender's display name from its presence, trimmed and bounded; '' when it has none. */
function reactionSenderName(state) {
  const name = state?.user?.name;
  return typeof name === 'string' ? name.trim().slice(0, DISPLAY_NAME_MAX_LENGTH) : '';
}

// This page's monotonic clock: send limits and playback never depend on wall-clock time or on other machines.
const pageClock = () => globalThis.performance.now();

/**
 * One page's reaction channel on `awareness`. `send(emoji)` publishes a reaction (rate-limited); subscribers get
 * `{ clientId, seq, emoji, name }` once per reaction from anyone, including this page's own, through one path.
 */
export function createReactionChannel(awareness, { now = pageClock, timers = globalThis } = {}) {
  const limiter = new IntervalLimiter(REACTION_SEND_INTERVAL_MS);
  const receiver = new ReactionReceiver();
  const listeners = new Set();
  let seq = 0;
  let clearTimer = null;
  let destroyed = false;
  // While this page publishes its own reaction, the time its send was allowed. The local change it causes is played
  // at that same time, so the send limit and the play cooldown, both one interval, always agree about it.
  let sendingAt = null;

  receiver.seed(awareness.getStates());
  const onChange = (changes) => {
    const states = awareness.getStates();
    for (const { clientId, reaction, state } of receiver.receive(changes, states, sendingAt ?? now())) {
      const event = Object.freeze({ clientId, seq: reaction.seq, emoji: reaction.emoji, name: reactionSenderName(state) });
      listeners.forEach((listener) => listener(event));
    }
  };
  awareness.on('change', onChange);

  const cancelClear = () => {
    if (clearTimer !== null) timers.clearTimeout(clearTimer);
    clearTimer = null;
  };
  const clearField = () => {
    clearTimer = null;
    if (awareness.getLocalState()?.[BOARD_REACTION_FIELD]) awareness.setLocalStateField(BOARD_REACTION_FIELD, null);
  };

  return {
    /** Publishes `emoji` to everyone; false when it is not a board reaction or the send limit dropped it. */
    send(emoji) {
      if (destroyed || !BOARD_REACTIONS.includes(emoji) || awareness.getLocalState() === null) return false;
      const at = now();
      if (!limiter.tryTake(at)) return false;
      seq += 1;
      cancelClear();
      sendingAt = at;
      try {
        awareness.setLocalStateField(BOARD_REACTION_FIELD, boardReaction(emoji, seq));
      } finally {
        sendingAt = null;
      }
      clearTimer = timers.setTimeout(clearField, REACTION_CLEAR_MS);
      return true;
    },
    cooldownMs: () => limiter.remainingMs(now()),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      awareness.off('change', onChange);
      listeners.clear();
      cancelClear();
      clearField();
    },
  };
}
