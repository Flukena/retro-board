import { zoneEffectiveRevealed } from './zone-actions.js';

const findZone = (context, id) => context.board.items.find((item) => item.id === id && item.type === 'zone');

// The adapter supplies current state; actions keep their identity across renders.
export function createZoneHeaderActions(getContext) {
  return {
    options(id) {
      getContext().selectZone(id);
    },
    toggleReveal(id) {
      const context = getContext();
      if (!context.isAdmin) return;
      const zone = findZone(context, id);
      if (!zone) return;
      const { items, allRevealed } = context.board;
      context.updateZone(id, { revealed: !zoneEffectiveRevealed(zone, items, allRevealed) });
    },
    vote(id) {
      const context = getContext();
      if (!context.isAdmin) return;
      const zone = findZone(context, id);
      if (!zone) return;
      if (zone.voteTimer) {
        context.stopTimer(id);
        return;
      }
      context.selectZone(id);
      context.clearEditing(null);
      context.openTimerSetup(true);
    },
  };
}
