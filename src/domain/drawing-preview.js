import { DRAWING_MAX_POINTS, DRAWING_MAX_STROKES, DRAWING_MAX_WIDTH_WORLD_PX, DRAWING_MAX_ERASER_WIDTH_WORLD_PX,
  DRAWING_INK_COLOR_PATTERN, isDrawingPoint, drawingBounds } from './freehand-drawing.js';
import { DRAWING_TOOL, DRAWING_TOOLS, isDrawingShape } from './drawing-shapes.js';
import { isEditableDrawingImage } from './drawing-image-target.js';
import { isSafeId } from './comment-schema.js';

export const DRAWING_BROADCAST_INTERVAL_MS = 100;
function readStroke(value) {
  const tool = value?.tool ?? DRAWING_TOOL.PEN;
  const maxWidth = tool === DRAWING_TOOL.ERASER ? DRAWING_MAX_ERASER_WIDTH_WORLD_PX : DRAWING_MAX_WIDTH_WORLD_PX;
  if (!DRAWING_TOOLS.includes(tool) || !DRAWING_INK_COLOR_PATTERN.test(value?.color) || !Number.isFinite(value?.width)
    || value.width <= 0 || value.width > maxWidth || !Array.isArray(value.points) || !value.points.length
    || value.points.length > DRAWING_MAX_POINTS || !value.points.every(isDrawingPoint)
    || (isDrawingShape(tool) && value.points.length > 2)) return null;
  return { tool, color: value.color, width: value.width, points: value.points.map(point => ({ x: point.x, y: point.y })) };
}
export function readDrawingPreview(value) {
  if (!value || !isSafeId(value.id) || (value.targetId !== null && !isSafeId(value.targetId))
    || !Array.isArray(value.strokes) || value.strokes.length > DRAWING_MAX_STROKES
    || (value.base !== null && !isEditableDrawingImage(value.base))) return null;
  const strokes = value.strokes.map(readStroke);
  if (strokes.some(stroke => !stroke) || strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) > DRAWING_MAX_POINTS) return null;
  const bounds = drawingBounds(strokes, value.base);
  return bounds ? { id: value.id, targetId: value.targetId, base: value.base, strokes, bounds } : null;
}
