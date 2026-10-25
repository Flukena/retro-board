import { IMPORT_COORDINATE_MAX_ABS, IMPORT_DIMENSION_MAX } from './security-boundaries.js';
import { DRAWING_TOOL, DRAWING_TOOLS, isDrawingShape, drawingEndPoint, drawingExtentPoints } from './drawing-shapes.js';
import { geometryErrorForItem } from './board-geometry.js';
import { VIEWPORT_ZOOM_MIN } from './viewport-limits.js';

export const DRAWING_MAX_POINTS = 8192;
export const DRAWING_MAX_STROKES = 128;
export const DRAWING_WIDTHS_SCREEN_PX = Object.freeze([2, 4, 8]);
export const DRAWING_DEFAULT_WIDTH_SCREEN_PX = 4;
export const DRAWING_ERASER_WIDTHS_SCREEN_PX = Object.freeze([12, 24, 48]);
export const DRAWING_DEFAULT_ERASER_WIDTH_SCREEN_PX = 24;
export const DRAWING_MAX_WIDTH_WORLD_PX = 160;
export const DRAWING_MAX_ERASER_WIDTH_WORLD_PX = Math.max(...DRAWING_ERASER_WIDTHS_SCREEN_PX) / VIEWPORT_ZOOM_MIN;
const DRAWING_EDGE_PADDING_PX = 1;
export const DRAWING_INK_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const isDrawingPoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y)
  && Math.abs(point.x) <= IMPORT_COORDINATE_MAX_ABS && Math.abs(point.y) <= IMPORT_COORDINATE_MAX_ABS;

export class DrawingDraft {
  #strokes = Object.freeze([]); #redo = []; #active = null; #revision = 0;
  get completedStrokes() { return this.#strokes; }
  get revision() { return this.#revision; }
  get pointCount() { return this.#strokes.reduce((count, stroke) => count + stroke.points.length, 0) + (this.#active?.points.length || 0); }
  get canUndo() { return !!this.#active || this.#strokes.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  get empty() { return !this.#strokes.length && !this.#active; }
  get strokes() { return this.#active ? [...this.#strokes, { ...this.#active, points: [...this.#active.points] }] : this.#strokes; }
  begin(point, { color, width, tool = DRAWING_TOOL.PEN }) {
    const maxWidth = tool === DRAWING_TOOL.ERASER ? DRAWING_MAX_ERASER_WIDTH_WORLD_PX : DRAWING_MAX_WIDTH_WORLD_PX;
    if (this.#active || !isDrawingPoint(point) || !DRAWING_INK_COLOR_PATTERN.test(color) || !DRAWING_TOOLS.includes(tool) || !(width > 0 && width <= maxWidth)
      || this.#strokes.length >= DRAWING_MAX_STROKES || this.pointCount >= DRAWING_MAX_POINTS) return false;
    this.#active = { color, width, points: [Object.freeze({ x: point.x, y: point.y })] };
    if (tool !== DRAWING_TOOL.PEN) this.#active.tool = tool;
    this.#revision++; return true;
  }
  append(point, minimumDistance) {
    if (!this.#active || !isDrawingPoint(point)) return false;
    if (isDrawingShape(this.#active.tool)) return this.#appendShape(point);
    const previous = this.#active.points.at(-1);
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < minimumDistance) return true;
    if (this.pointCount >= DRAWING_MAX_POINTS) return false;
    this.#active.points.push(Object.freeze({ x: point.x, y: point.y })); this.#revision++; return true;
  }
  #appendShape(point) {
    const end = drawingEndPoint(this.#active.tool, this.#active.points[0], point);
    if (!isDrawingPoint(end) || (this.#active.points.length === 1 && this.pointCount >= DRAWING_MAX_POINTS)) return false;
    this.#active.points[1] = Object.freeze({ x: end.x, y: end.y }); this.#revision++; return true;
  }
  end() {
    if (!this.#active) return;
    const stroke = this.#active; stroke.points.forEach(Object.freeze); Object.freeze(stroke.points); Object.freeze(stroke);
    this.#strokes = Object.freeze([...this.#strokes, stroke]); this.#active = null; this.#redo = []; this.#revision++;
  }
  cancelStroke() { if (this.#active) { this.#active = null; this.#revision++; } }
  undo() {
    if (this.#active) { this.cancelStroke(); return; }
    if (!this.#strokes.length) return;
    this.#redo.push(this.#strokes.at(-1)); this.#strokes = Object.freeze(this.#strokes.slice(0, -1)); this.#revision++;
  }
  redo() {
    this.cancelStroke();
    const stroke = this.#redo.pop(); if (!stroke) return;
    this.#strokes = Object.freeze([...this.#strokes, stroke]); this.#revision++;
  }
  clear() { this.#strokes = Object.freeze([]); this.#redo = []; this.#active = null; this.#revision++; }
}

export function drawingBounds(strokes, base = null) {
  if ((!strokes.length && !base) || (base && geometryErrorForItem(base))) return null;
  let left = base?.x ?? Infinity, top = base?.y ?? Infinity;
  let right = base ? base.x + base.w : -Infinity, bottom = base ? base.y + base.h : -Infinity;
  for (const stroke of strokes.filter(value => value.tool !== DRAWING_TOOL.ERASER)) for (const point of drawingExtentPoints(stroke)) {
    const padding = stroke.width / 2 + DRAWING_EDGE_PADDING_PX;
    left = Math.min(left, point.x - padding); top = Math.min(top, point.y - padding);
    right = Math.max(right, point.x + padding); bottom = Math.max(bottom, point.y + padding);
  }
  if (![left, top, right, bottom].every(value => Number.isFinite(value) && Math.abs(value) <= IMPORT_COORDINATE_MAX_ABS)
    || right - left > IMPORT_DIMENSION_MAX || bottom - top > IMPORT_DIMENSION_MAX) return null;
  if (base && left === base.x && top === base.y && right === base.x + base.w && bottom === base.y + base.h) return { ...base };
  return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
}
