import { zoneGroupIds } from '../../domain/zone-actions.js';
import { effectiveOwnerZone } from '../../domain/board-ownership.js';

export function createVoteFinalizationController({
  boardRef, recentMoves, view = globalThis.window, clock = globalThis.Date, setBoard,
}) {
  const finalizeVotingSession = (zoneId) => {
    const b = boardRef.current;
    const rootZone = b.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!rootZone?.voteTimer) return;
    const group = zoneGroupIds(rootZone, b.items);
    const ids = b.items.filter((item) => group.has(item.id) || group.has(effectiveOwnerZone(item, b.items)?.id))
      .map(item => item.id);
    recentMoves.forget(ids);
    const plan = view.storage.finalizeVoteSession(zoneId, rootZone.voteTimer.startedAt, view.storage.getVoteResultParticipants(), clock.now());
    if (!plan) return;
    const patchById = new Map(plan.entries.map((entry) => [entry.id, entry.patch]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((item) => (
        patchById.has(item.id) ? { ...item, ...patchById.get(item.id) } : item
      )),
    }));
  };
  return { finalizeVotingSession };
}
