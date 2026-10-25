export const DRAWING_TOOL = Object.freeze({ PEN: 'pen', ERASER: 'eraser', RECTANGLE: 'rectangle', CIRCLE: 'circle', ARROW: 'arrow' });
export const DRAWING_TOOLS = Object.freeze(Object.values(DRAWING_TOOL));
const SHAPE_TOOLS = new Set([DRAWING_TOOL.RECTANGLE, DRAWING_TOOL.CIRCLE, DRAWING_TOOL.ARROW]);
const ARROW_HEAD_WIDTH_FACTOR = 4;
const HALF = 2;

export const isDrawingShape = tool => SHAPE_TOOLS.has(tool);
export function drawingEndPoint(tool, start, end) {
  if (tool !== DRAWING_TOOL.CIRCLE) return end;
  const dx = end.x - start.x, dy = end.y - start.y;
  const diameter = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + (Math.sign(dx) || 1) * diameter, y: start.y + (Math.sign(dy) || 1) * diameter };
}
export function arrowHead(start, end, width) {
  const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
  if (!length) return null;
  const headLength = Math.min(width * ARROW_HEAD_WIDTH_FACTOR, length / HALF);
  const ux = dx / length, uy = dy / length;
  const base = { x: end.x - ux * headLength, y: end.y - uy * headLength };
  return { base, left: { x: base.x - uy * headLength / HALF, y: base.y + ux * headLength / HALF },
    right: { x: base.x + uy * headLength / HALF, y: base.y - ux * headLength / HALF } };
}
export function drawingExtentPoints(stroke) {
  if (stroke.tool !== DRAWING_TOOL.ARROW || stroke.points.length < HALF) return stroke.points;
  const head = arrowHead(stroke.points[0], stroke.points.at(-1), stroke.width);
  return head ? [...stroke.points, head.left, head.right] : stroke.points;
}
