import { isEditableDrawingImage } from '../../domain/drawing-image-target.js';
import { IMAGE_OUTPUT_MAX_DIMENSION, inspectRasterImageBlob, imageInfoIsWithinLimits } from '../../domain/security-boundaries.js';
import { readBackupImage } from '../transfer/image-upload.js';

const PNG_MIME = 'image/png';
export async function loadDrawingImage(target, { signal, readImage = readBackupImage, decode = createImageBitmap } = {}) {
  if (!isEditableDrawingImage(target) || signal?.aborted) return null;
  const blob = await readImage(target.src, { signal });
  const info = await inspectRasterImageBlob(blob);
  if (signal?.aborted || !imageInfoIsWithinLimits(info) || info.mime !== PNG_MIME
    || Math.max(info.width, info.height) > IMAGE_OUTPUT_MAX_DIMENSION) return null;
  const image = await decode(blob);
  if (signal?.aborted) { image.close(); return null; }
  return { image, bounds: { x: target.x, y: target.y, w: target.w, h: target.h } };
}
