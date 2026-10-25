import { DRAWING_TOOL } from '../../domain/drawing-shapes.js';
import { paintDrawingPath } from './drawing-paths.js';
import { drawingBounds } from '../../domain/freehand-drawing.js';
import { IMAGE_MAX_BYTES, IMAGE_OUTPUT_MAX_DIMENSION } from '../../domain/security-boundaries.js';
import { canvasToBlob } from '../transfer/image-upload.js';

export const DRAWING_PREVIEW_MAX_PIXELS = 8_388_608;
const DRAWING_PREVIEW_MAX_EDGE_PX = 4096;
const DRAWING_MAX_DPR = 2;
const PNG_MIME = 'image/png';
const SOURCE_OVER = 'source-over';
const DESTINATION_OUT = 'destination-out';
const ALPHA_CHANNEL_INDEX = 3;
const PIXEL_CHANNEL_COUNT = 4;

export function paintDrawing(ctx, strokes, base = null) {
  ctx.globalCompositeOperation = SOURCE_OVER;
  if (base) ctx.drawImage(base.image, base.bounds.x, base.bounds.y, base.bounds.w, base.bounds.h);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    ctx.globalCompositeOperation = stroke.tool === DRAWING_TOOL.ERASER ? DESTINATION_OUT : SOURCE_OVER;
    ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color; ctx.lineWidth = stroke.width;
    paintDrawingPath(ctx, stroke);
  }
  ctx.globalCompositeOperation = SOURCE_OVER;
}
function canvasHasInk(ctx, canvas) {
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = ALPHA_CHANNEL_INDEX; index < pixels.length; index += PIXEL_CHANNEL_COUNT) if (pixels[index]) return true;
  return false;
}

export function resizeDrawingPreview(canvas, viewportWidth, viewportHeight, dpr) {
  const ratio = Math.min(dpr, DRAWING_MAX_DPR, DRAWING_PREVIEW_MAX_EDGE_PX / Math.max(viewportWidth, viewportHeight),
    Math.sqrt(DRAWING_PREVIEW_MAX_PIXELS / (viewportWidth * viewportHeight)));
  canvas.width = Math.max(1, Math.floor(viewportWidth * ratio)); canvas.height = Math.max(1, Math.floor(viewportHeight * ratio));
  return ratio;
}

export async function drawingArtifact(strokes, density, document, base = null) {
  const bounds = drawingBounds(strokes, base?.bounds);
  if (!bounds || !Number.isFinite(density) || density <= 0) return null;
  const baseDensity = base ? Math.max((base.image.width || 0) / base.bounds.w, (base.image.height || 0) / base.bounds.h) : 0;
  const ratio = Math.min(Math.max(density, baseDensity), IMAGE_OUTPUT_MAX_DIMENSION / Math.max(bounds.w, bounds.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.min(IMAGE_OUTPUT_MAX_DIMENSION, Math.ceil(bounds.w * ratio)));
  canvas.height = Math.max(1, Math.min(IMAGE_OUTPUT_MAX_DIMENSION, Math.ceil(bounds.h * ratio)));
  try {
    const ctx = canvas.getContext('2d'); if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, -bounds.x * ratio, -bounds.y * ratio); paintDrawing(ctx, strokes, base);
    if (!base && strokes.some(stroke => stroke.tool === DRAWING_TOOL.ERASER) && !canvasHasInk(ctx, canvas)) return { empty: true };
    const blob = await canvasToBlob(canvas, PNG_MIME);
    return blob?.type === PNG_MIME && blob.size > 0 && blob.size <= IMAGE_MAX_BYTES
      ? { blob, bounds, natW: canvas.width, natH: canvas.height } : null;
  } finally { canvas.width = 0; canvas.height = 0; }
}
