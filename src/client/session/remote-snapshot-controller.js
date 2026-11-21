import { applyRemoteSnapshot, shouldDropSnapshotFocus } from '../../domain/apply-remote-snapshot.js';

export function createRemoteSnapshotController({
  boardRef, userIdRef, focusedTextIdRef, dragItemsRef, recentlyMovedRef,
  recentMoves, updateFocusedText, setBoard, clock = globalThis.Date,
}) {
  return (remote, isUndoRedo, deletedItemIds = []) => {
    if (!remote) return;
    const pendingContext = { isUndoRedo, deletedItemIds: new Set(deletedItemIds), userId: userIdRef.current, nowMs: clock.now() };
    // Undo/redo clears existing drag protection before focus handling. The lazy
    // updater still reads moves recorded after this event, as in the base owner.
    if (isUndoRedo) recentlyMovedRef.current.clear();
    const focusedItemId = focusedTextIdRef.current?.split(':')[0] || null;
    if (shouldDropSnapshotFocus(boardRef.current, remote, focusedItemId, pendingContext)) updateFocusedText(null);
    setBoard((previous) => {
      const result = applyRemoteSnapshot(previous, remote, {
        ...pendingContext, draggedIds: dragItemsRef.current,
        recentMoves: recentlyMovedRef.current, moveNowMs: clock.now(),
      });
      recentMoves.forget(result.forgetMoveIds);
      return result.board;
    });
  };
}
