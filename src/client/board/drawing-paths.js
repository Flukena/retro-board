import { DRAWING_TOOL, arrowHead } from '../../domain/drawing-shapes.js';

const FULL_CIRCLE_RADIANS = Math.PI * 2;
const HALF = 2;
function dot(ctx, point, width) { ctx.arc(point.x, point.y, width / HALF, 0, FULL_CIRCLE_RADIANS); ctx.fill(); }
function line(ctx, points) {
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.stroke();
}
function circle(ctx, first, last) {
  const radius = Math.abs(last.x - first.x) / HALF;
  if (!radius) return;
  ctx.arc((first.x + last.x) / HALF, (first.y + last.y) / HALF, radius, 0, FULL_CIRCLE_RADIANS); ctx.stroke();
}
function arrow(ctx, points, width) {
  const first = points[0], last = points.at(-1), head = arrowHead(first, last, width);
  if (!head) { dot(ctx, first, width); return; }
  line(ctx, [first, head.base]); ctx.beginPath();
  ctx.moveTo(last.x, last.y); ctx.lineTo(head.left.x, head.left.y); ctx.lineTo(head.right.x, head.right.y); ctx.closePath(); ctx.fill();
}
export function paintDrawingPath(ctx, stroke) {
  const first = stroke.points[0], last = stroke.points.at(-1);
  if (!first) return;
  ctx.beginPath();
  if (stroke.points.length === 1 || (first.x === last.x && first.y === last.y)) { dot(ctx, first, stroke.width); return; }
  switch (stroke.tool) {
    case DRAWING_TOOL.RECTANGLE: ctx.rect(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.abs(last.x - first.x), Math.abs(last.y - first.y)); ctx.stroke(); break;
    case DRAWING_TOOL.CIRCLE: circle(ctx, first, last); break;
    case DRAWING_TOOL.ARROW: arrow(ctx, stroke.points, stroke.width); break;
    default: line(ctx, stroke.points);
  }
}
