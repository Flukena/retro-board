import { finalizeExpiredVotes } from '../domain/vote-expiry.js';

export const finalizeRelayVotes = (ydoc, Y, atTime, invalidGeometry) =>
  finalizeExpiredVotes(ydoc, Y, ydoc.awareness, atTime, invalidGeometry);

export const maintainRoomVotes = (docs, finalize, atTime, onError) => {
  for (const [name, doc] of docs) {
    try { finalize(name, doc, atTime); }
    catch (err) { onError(name, err); }
  }
};
