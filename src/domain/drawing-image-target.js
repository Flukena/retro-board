import { geometryErrorForItem } from './board-geometry.js';

const EDITABLE_DRAWING_EXTENSION = /\.png$/i;
const TARGET_FIELDS = Object.freeze(['src', 'x', 'y', 'w', 'h', 'natW', 'natH']);
export const isEditableDrawingImage = item => item?.type === 'image' && typeof item.src === 'string' && EDITABLE_DRAWING_EXTENSION.test(item.src)
  && item.w > 0 && item.h > 0 && !geometryErrorForItem(item);
export function drawingTargetUnchanged(target, items) {
  const current = items.find(item => item.id === target.id);
  return isEditableDrawingImage(current) && TARGET_FIELDS.every(field => current[field] === target[field]);
}
