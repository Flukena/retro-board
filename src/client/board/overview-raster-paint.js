import { STICKY_AUTO_TEXT } from '../ui/palette.js';

import { CARD_OVERVIEW_FOOTER_HEIGHT_PX } from '../../domain/viewport-limits.js';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The canvas font shorthand omits weight, so atlas text uses normal (400).
const NORMAL_CANVAS_FONT_WEIGHT = 400;
const normalizedFamily = family => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
function includesNormalWeight(weight = 'normal') {
  if (weight === 'normal') return true;
  const [minimum, maximum = minimum] = weight.split(/\s+/).map(Number);
  return minimum <= NORMAL_CANVAS_FONT_WEIGHT && maximum >= NORMAL_CANVAS_FONT_WEIGHT;
}

export function overviewFontLoadAffectsPaint(event, fontFamily) {
  if (!fontFamily || !Array.isArray(event?.fontfaces)) return true;
  const families = new Set(fontFamily.split(',').map(normalizedFamily));
  return event.fontfaces.some(face => families.has(normalizedFamily(face.family)) && includesNormalWeight(face.weight));
}

function paragraphLines(ctx, paragraph, width) {
  if (ctx.measureText(paragraph).width <= width) return [paragraph];
  const lines = [];
  let line = '';
  for (const { segment } of graphemes.segment(paragraph)) {
    if (line && ctx.measureText(line + segment).width > width) {
      const space = line.lastIndexOf(' ');
      lines.push(space > 0 ? line.slice(0, space) : line);
      line = space > 0 ? line.slice(space + 1) : '';
    }
    line += segment;
  }
  lines.push(line);
  return lines;
}

export function rasterTextLines(ctx, text, width) {
  return text.split('\n').flatMap(paragraph => paragraphLines(ctx, paragraph, width));
}

export class OverviewRasterPainter {
  #canvas; #model; #ctx; #style; #hovered = null; #hidden = new Set();
  constructor(canvas, model) {
    this.#canvas = canvas; this.#model = model; this.#ctx = canvas.getContext('2d');
  }
  draw(style) {
    if (!this.#ctx || !style.fontFamily || !Number.isFinite(style.padding) || style.padding < 0
      || !Number.isFinite(style.lineHeight) || style.lineHeight <= 0) return false;
    this.#style = style;
    const { bounds, scale, width, height, rows } = this.#model;
    this.#canvas.width = width; this.#canvas.height = height;
    this.#ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
    for (const row of rows) if (row.id !== this.#hovered && !this.#hidden.has(row.id)) this.#paint(row);
    return true;
  }
  #paint(row) {
    const ctx = this.#ctx, style = this.#style;
    const width = row.w - style.padding * 2, height = Math.max(0, row.h - CARD_OVERVIEW_FOOTER_HEIGHT_PX);
    ctx.save(); ctx.beginPath(); ctx.rect(row.x + style.padding, row.y + style.padding, width, height); ctx.clip();
    ctx.font = `${row.fontSize}px ${style.fontFamily}`; ctx.fillStyle = row.color || STICKY_AUTO_TEXT; ctx.textBaseline = 'top';
    const lineHeight = row.fontSize * style.lineHeight;
    const lines = rasterTextLines(ctx, row.text, width);
    for (let index = 0; index < lines.length && index * lineHeight < height; index++) {
      ctx.fillText(lines[index], row.x + style.padding, row.y + style.padding + index * lineHeight);
    }
    ctx.restore();
  }
  setHidden(ids) {
    const next = new Set(ids);
    if (this.#ctx && this.#style) for (const row of this.#model.rows) {
      if (row.id === this.#hovered || next.has(row.id) === this.#hidden.has(row.id)) continue;
      if (next.has(row.id)) this.#ctx.clearRect(row.x, row.y, row.w, row.h);
      else this.#paint(row);
    }
    this.#hidden = next;
  }
  hover(id) {
    if (!this.#ctx || !this.#style || id === this.#hovered) return;
    const previous = this.#model.rows.find(row => row.id === this.#hovered);
    if (previous && !this.#hidden.has(previous.id)) this.#paint(previous);
    this.#hovered = id;
    const row = this.#model.rows.find(entry => entry.id === id);
    if (row && !this.#hidden.has(row.id)) this.#ctx.clearRect(row.x, row.y, row.w, row.h);
  }
}
