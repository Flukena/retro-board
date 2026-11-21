export function undoBlockReason(midDrag, locked) {
  if (midDrag) return 'topbar.finishDragFirst';
  if (locked) return 'common.warnLockEdit';
  return null;
}
