import { zoneEffectiveRevealed } from './zone-actions.js';

const findZone = (context, id) => context.board.items.find((item) => item.id === id && item.type === 'zone');

function zoneAction(getContext, guard, action) {
  return (id, ...args) => {
    const context = getContext();
    const zone = findZone(context, id);
    if (zone && guard(context, zone)) action(context, zone, ...args);
  };
}
const canRead = () => true;
const canEdit = (context, zone) => context.canModify(zone);
const canRemove = (context, zone) => context.canDelete(zone);
const canAdmin = (context) => context.isAdmin;

// The adapter supplies current state; actions keep their identity across renders.
export function createZoneHeaderActions(getContext) {
  return {
    color: zoneAction(getContext, canEdit, (context, zone, color) => context.updateZone(zone.id, { color })),
    fontSize: zoneAction(getContext, canEdit, (context, zone, fontSize) => context.updateZone(zone.id, { fontSize })),
    toggleLock: zoneAction(getContext, canEdit, (context, zone) => context.updateZone(zone.id, { locked: !zone.locked })),
    exportCsv: zoneAction(getContext, canRead, (context, zone) => context.exportCsv(zone)),
    saveTemplate: zoneAction(getContext, canRead, (context, zone) => context.openSaveTemplate(context.board.items, new Set([zone.id]))),
    bringToFront: zoneAction(getContext, canEdit, (context, zone) => context.bringToFront(new Set([zone.id]))),
    sendToBack: zoneAction(getContext, canEdit, (context, zone) => context.sendToBack(new Set([zone.id]))),
    remove: zoneAction(getContext, canRemove, (context, zone) => context.deleteItemsIfAllowed([zone.id])),
    toggleReveal: zoneAction(getContext, canAdmin, (context, zone) => {
      const { items, allRevealed } = context.board;
      context.updateZone(zone.id, { revealed: !zoneEffectiveRevealed(zone, items, allRevealed) });
    }),
    vote: zoneAction(getContext, canAdmin, (context, zone) => {
      if (zone.voteTimer) {
        context.stopTimer(zone.id);
        return;
      }
      context.clearEditing(null);
      context.openTimerSetup(zone.id);
    }),
    startTimer: zoneAction(getContext, canAdmin, (context, zone, ...args) => context.startTimer(zone.id, ...args)),
    closeTimerSetup() { getContext().openTimerSetup(null); },
  };
}
