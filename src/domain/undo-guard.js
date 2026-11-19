export function undoBlockReason(midDrag, locked, hasUndo = true) {
  if (midDrag) return 'topbar.finishDragFirst';
  if (locked) return 'common.warnLockEdit';
  if (!hasUndo) return 'topbar.nothingToUndo';
  return null;
}
