import { reconcileBoardSnapshot } from './board-reconciliation.js';
import { shouldPreserveRecentLocalItem } from './pending-local-items.js';

export function shouldDropSnapshotFocus(previous, remote, focusedItemId, context) {
  if (!focusedItemId || remote.items?.some(item => item.id === focusedItemId)) return false;
  const localFocused = previous.items.find(item => item.id === focusedItemId);
  return !shouldPreserveRecentLocalItem(localFocused, context);
}

// Ref mutation belongs to the caller, after reconciliation in the same updater.
export function applyRemoteSnapshot(previous, remote, context) {
  const result = reconcileBoardSnapshot(previous, remote, {
    ...context,
    recentMoves: context.isUndoRedo ? new Map() : context.recentMoves,
  });
  return {
    board: result.board,
    forgetMoveIds: [...context.recentMoves.keys()].filter(id => !result.recentMoves.has(id)),
  };
}
