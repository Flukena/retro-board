import { DEFAULT_BOARD } from './board-state.js';
import { reuseBoardReferences } from './snapshot-references.js';
import { shouldPreserveRecentLocalItem } from './pending-local-items.js';

function withLocalGeometry(remote, geometry) {
  const next = { ...remote, x: geometry.x, y: geometry.y };
  if (geometry.w != null) next.w = geometry.w;
  if (geometry.h != null) next.h = geometry.h;
  return next;
}

function reconcileItem(remote, previous, draggedIds, recentMoves) {
  if (!previous) return remote;
  if (draggedIds?.has(remote.id)) return withLocalGeometry(remote, previous);
  const moved = recentMoves.get(remote.id);
  return moved ? withLocalGeometry(remote, moved) : remote;
}

export function reconcileBoardSnapshot(previous, remote, context) {
  const recentMoves = new Map([...context.recentMoves].filter(([, move]) => move.until > context.moveNowMs));
  const board = { ...DEFAULT_BOARD, ...remote };
  const remoteIds = new Set(board.items.map(item => item.id));
  if (context.draggedIds?.size || recentMoves.size) {
    const previousById = new Map(previous.items.map(item => [item.id, item]));
    board.items = board.items.map(item => reconcileItem(item, previousById.get(item.id), context.draggedIds, recentMoves));
  }
  const localOnly = previous.items.filter(item => !remoteIds.has(item.id) && shouldPreserveRecentLocalItem(item, context));
  if (localOnly.length) board.items = [...board.items, ...localOnly];
  return { board: reuseBoardReferences(previous, board), recentMoves };
}
