import { drawingTargetUnchanged } from '../../domain/drawing-image-target.js';
import { resolveOwnerZone } from '../../domain/board-ownership.js';

const canCommitDrawing = (operations, target) => operations.isCurrent() && operations.canEdit()
  && (!target || drawingTargetUnchanged(target, operations.items()));

export async function saveDrawingArtifact(artifact, operations, target = null) {
  if (!artifact?.blob || !canCommitDrawing(operations, target)) return false;
  let src;
  try { src = await operations.uploadImage(artifact.blob); }
  catch (error) { operations.uploadFailed(error); return false; }
  if (!src || !canCommitDrawing(operations, target)) return false;
  const { authorId, authorName } = operations.author();
  const item = { id: target?.id ?? operations.createId(), type: 'image', ...artifact.bounds, src,
    natW: artifact.natW, natH: artifact.natH, authorId, authorName, createdAt: operations.now() };
  item.parentZoneId = resolveOwnerZone(item, operations.items())?.id ?? null;
  operations.stopUndoCapture();
  const added = target
    ? operations.updateItem(target.id, { ...artifact.bounds, src, natW: artifact.natW, natH: artifact.natH, parentZoneId: item.parentZoneId })
    : operations.addItem(item);
  operations.stopUndoCapture();
  if (added) operations.selectItem(item.id);
  return added;
}
