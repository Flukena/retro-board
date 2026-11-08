import { geometryErrorForItem } from './board-geometry.js';
import { isE2EImageSource } from './security-boundaries.js';

const EDITABLE_DRAWING_EXTENSION = /\.png$/i;
const TARGET_FIELDS = Object.freeze(['src', 'x', 'y', 'w', 'h', 'natW', 'natH']);
// Encrypted blobs carry no extension; the loader checks their decrypted type is PNG before editing.
const hasEditableSource = src => typeof src === 'string' && (EDITABLE_DRAWING_EXTENSION.test(src) || isE2EImageSource(src));
export const isEditableDrawingImage = item => item?.type === 'image' && hasEditableSource(item.src)
  && item.w > 0 && item.h > 0 && !geometryErrorForItem(item);
export function drawingTargetUnchanged(target, items) {
  const current = items.find(item => item.id === target.id);
  return isEditableDrawingImage(current) && TARGET_FIELDS.every(field => current[field] === target[field]);
}
