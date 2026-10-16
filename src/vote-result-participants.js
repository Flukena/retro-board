import { isAwarenessSlotFresh } from './awareness-liveness.js';
import { normalizeResultParticipant } from './vote-results.js';

// Preserve every candidate for deterministic result-name selection. Motion and
// sender timestamps are unrelated to voting and must never be inspected here.
export function readVoteResultParticipants(awareness, atTime = Date.now()) {
  const participants = [];
  const states = awareness?.getStates() || new Map();
  states.forEach((state, clientId) => {
    if (!isAwarenessSlotFresh(awareness.meta, clientId, atTime)) return;
    const candidate = normalizeResultParticipant(state?.user);
    if (candidate) participants.push(candidate);
  });
  return participants;
}
