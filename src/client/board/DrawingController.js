import { attachMobileGestures } from './mobile-gestures.js';
import { paintDrawing, resizeDrawingPreview } from './drawing-paint.js';
import { DRAWING_TOOL } from '../../domain/drawing-shapes.js';
import { STICKY_AUTO_TEXT } from '../ui/palette.js';

const PRIMARY_BUTTON = 0;
const MIDDLE_BUTTON = 1;
const SAMPLE_SPACING_SCREEN_PX = 1;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const NATIVE_EDITOR_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

export class DrawingController {
  constructor(canvas, draft, operations) {
    this.canvas = canvas; this.draft = draft; this.operations = operations;
    this.view = canvas.ownerDocument.defaultView; this.ctx = canvas.getContext('2d');
    this.listeners = []; this.frame = null; this.stroke = false; this.pan = null; this.space = false; this.disposed = false;
  }
  listen(target, type, action, options) {
    target.addEventListener(type, action, options); this.listeners.push(() => target.removeEventListener(type, action, options));
  }
  beginGesture() { this.operations.stopFollowing(); this.operations.beginGesture(); }
  attach() {
    this.listen(this.canvas, 'mousedown', event => this.down(event));
    this.listen(this.view, 'mousemove', event => this.move(event));
    this.listen(this.view, 'mouseup', event => this.up(event));
    this.listen(this.canvas, 'pointercancel', () => this.cancelGesture());
    this.listen(this.canvas, 'wheel', event => this.wheel(event), { passive: false });
    this.listen(this.view, 'resize', () => this.resize());
    this.listen(this.view, 'blur', () => { this.space = false; this.cancelGesture(); });
    this.listen(this.view, 'keydown', event => this.key(event), true);
    this.listen(this.view, 'keyup', event => { if (event.code === 'Space') { this.space = false; this.cursor(); } });
    this.disposeTouch = attachMobileGestures(this.canvas, {
      getViewport: () => this.operations.viewport(), beginGesture: () => this.beginGesture(),
      cancelGesture: () => this.cancelGesture(),
      applyViewport: next => { this.operations.applyViewport(next); this.requestPaint(); },
      commitViewport: next => { this.operations.commitViewport(next); this.requestPaint(); },
    }, { nativeSurface: true });
    this.resize(); return () => this.dispose();
  }
  point(event) {
    const rect = this.canvas.getBoundingClientRect(), view = this.operations.viewport();
    return { x: (event.clientX - rect.left - view.x) / view.zoom, y: (event.clientY - rect.top - view.y) / view.zoom };
  }
  down(event) {
    if (event.button !== PRIMARY_BUTTON && event.button !== MIDDLE_BUTTON) return;
    event.preventDefault(); this.beginGesture();
    if (this.space || event.button === MIDDLE_BUTTON) {
      this.pan = { x: event.clientX, y: event.clientY, viewport: this.operations.viewport() }; this.cursor(); return;
    }
    if (!this.ctx || !this.operations.canDraw()) return;
    const settings = this.operations.settings();
    if (settings.tool === DRAWING_TOOL.ERASER && this.draft.empty && !this.operations.baseImage?.()) return;
    const themeInk = this.view.getComputedStyle(this.canvas).getPropertyValue('--text').trim();
    const color = settings.color ?? (COLOR_PATTERN.test(themeInk) ? themeInk : STICKY_AUTO_TEXT);
    this.stroke = this.draft.begin(this.point(event), { color, width: settings.width / this.operations.viewport().zoom, tool: settings.tool });
    if (!this.stroke) this.operations.limitReached();
    this.changed();
  }
  move(event) {
    if (this.pan) {
      const previous = this.pan.viewport;
      this.operations.applyViewport({ ...previous, x: previous.x + event.clientX - this.pan.x, y: previous.y + event.clientY - this.pan.y });
      this.requestPaint(); return;
    }
    if (!this.stroke) return;
    if (!this.draft.append(this.point(event), SAMPLE_SPACING_SCREEN_PX / this.operations.viewport().zoom)) {
      this.draft.end(); this.stroke = false; this.operations.limitReached(); this.changed();
    }
    this.operations.previewChanged?.(); this.requestPaint();
  }
  up(event) {
    if (this.pan) { this.move(event); this.operations.commitViewport(this.operations.viewport()); this.pan = null; this.cursor(); }
    if (!this.stroke) return;
    this.move(event); this.finishStroke();
  }
  finishStroke() { if (this.stroke) { this.draft.end(); this.stroke = false; this.changed(); } }
  cancelGesture() {
    this.draft.cancelStroke(); this.stroke = false;
    if (this.pan) { this.operations.commitViewport(this.operations.viewport()); this.pan = null; }
    this.changed(); this.cursor();
  }
  key(event) {
    if (event.target.closest?.(NATIVE_EDITOR_SELECTOR)) return;
    if (event.code === 'Space') { this.space = true; event.preventDefault(); this.cursor(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.operations.cancel(); return; }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (this.operations.busy()) return;
    if (event.shiftKey) this.draft.redo(); else this.draft.undo();
    this.stroke = false; this.changed();
  }
  wheel(event) {
    event.preventDefault();
    if (this.stroke || this.pan) return;
    const board = this.operations.boardCanvas();
    board?.dispatchEvent(new this.view.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: event.deltaX,
      deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
      clientX: event.clientX, clientY: event.clientY }));
    this.requestPaint();
  }
  changed() { if (!this.disposed) this.operations.changed(); this.operations.previewChanged?.(); this.requestPaint(); }
  cursor() { this.canvas.style.cursor = this.pan ? 'grabbing' : this.space ? 'grab' : 'crosshair'; }
  resize() {
    this.ratio = resizeDrawingPreview(this.canvas, this.view.innerWidth, this.view.innerHeight, this.view.devicePixelRatio || 1);
    this.requestPaint();
  }
  requestPaint() {
    if (this.disposed || this.frame !== null) return;
    this.frame = this.view.requestAnimationFrame(() => { this.frame = null; this.paint(); });
  }
  paint() {
    if (!this.ctx) return;
    const view = this.operations.viewport(), ratio = this.ratio;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.setTransform(ratio * view.zoom, 0, 0, ratio * view.zoom, ratio * view.x, ratio * view.y);
    paintDrawing(this.ctx, this.draft.strokes, this.operations.baseImage?.());
  }
  dispose() {
    this.disposed = true; this.disposeTouch?.(); this.draft.cancelStroke(); this.stroke = false;
    if (this.frame !== null) this.view.cancelAnimationFrame(this.frame);
    this.listeners.forEach(remove => remove()); this.listeners = []; this.canvas.width = 0; this.canvas.height = 0;
  }
}
