import { rasterTextLines } from '../board/overview-raster-paint.js';

// Pure canvas painting for a measured board scene. A "plate" is one rendered
// element (card, chip, label, image) already measured from the live DOM, so the
// picture follows the real CSS instead of a hand-written copy of it.

// Shapes that only cast a shadow are drawn this far off-canvas; the shadow
// offset brings the shadow back, so the shape itself is never visible.
const SHADOW_CASTER_OFFSET_PX = 100_000;
// The caster is never visible; it only has to be opaque because canvas
// multiplies the shadow colour by the caster's alpha.
const SHADOW_CASTER_FILL = 'black';
const HALF = 0.5;
const FULL_CIRCLE_RAD = Math.PI * 2;
// Layout widths are rounded; canvas measures fractions. Without this slack a
// word that fits on the page can wrap on the canvas.
const WRAP_TOLERANCE_PX = 0.5;
// Dash and gap lengths in border widths, close to how browsers draw them.
const DASH_PATTERNS = Object.freeze({ dashed: [3, 3], dotted: [1, 1] });

const SHADOW_PART = /(?:[a-z]+\([^)]*\)|#[\da-f]+|[a-z]+)|-?[\d.]+px|-?[\d.]+/gi;

function parseShadow(part, scale) {
  const tokens = part.match(SHADOW_PART) || [];
  if (tokens.includes('inset')) return null;
  const color = tokens.find(token => !/^-?[\d.]/.test(token));
  const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = tokens
    .filter(token => /^-?[\d.]/.test(token)).map(token => Number.parseFloat(token) * scale);
  return color ? { color, offsetX, offsetY, blur, spread } : null;
}

/** Split a computed `box-shadow` into layers, scaled to scene pixels. */
export function parseBoxShadows(css, scale) {
  if (!css || css === 'none') return [];
  return css.split(/,(?![^(]*\))/).map(part => parseShadow(part.trim(), scale)).filter(Boolean);
}

/** Where an image lands inside its box for a CSS `object-fit` value. */
export function imageDrawRect(box, image, fit) {
  if (fit !== 'contain' && fit !== 'cover') return { ...box };
  const pick = fit === 'contain' ? Math.min : Math.max;
  const scale = pick(box.w / image.width, box.h / image.height);
  const w = image.width * scale, h = image.height * scale;
  return { x: box.x + (box.w - w) * HALF, y: box.y + (box.h - h) * HALF, w, h };
}

function shapePath(ctx, { x, y, w, h }, radius) {
  ctx.beginPath();
  if (radius > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
}

function paintShadow(ctx, plate, shadow) {
  const box = { x: plate.x - shadow.spread - SHADOW_CASTER_OFFSET_PX, y: plate.y - shadow.spread,
    w: plate.w + shadow.spread * 2, h: plate.h + shadow.spread * 2 };
  if (box.w <= 0 || box.h <= 0) return;
  ctx.save();
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetX = shadow.offsetX + SHADOW_CASTER_OFFSET_PX;
  ctx.shadowOffsetY = shadow.offsetY;
  ctx.fillStyle = SHADOW_CASTER_FILL;
  shapePath(ctx, box, Math.max(0, plate.radius + shadow.spread));
  ctx.fill();
  ctx.restore();
}

function paintBorder(ctx, plate) {
  const inset = plate.border.width * HALF;
  ctx.strokeStyle = plate.border.color;
  ctx.lineWidth = plate.border.width;
  const dash = DASH_PATTERNS[plate.border.style];
  if (dash) ctx.setLineDash(dash.map(length => length * plate.border.width));
  shapePath(ctx, { x: plate.x + inset, y: plate.y + inset, w: plate.w - plate.border.width, h: plate.h - plate.border.width },
    Math.max(0, plate.radius - inset));
  ctx.stroke();
}

function paintImage(ctx, plate, image) {
  if (!image) return;
  const target = imageDrawRect(plate, image, plate.image.fit);
  ctx.save();
  shapePath(ctx, plate, plate.radius);
  ctx.clip();
  ctx.drawImage(image, target.x, target.y, target.w, target.h);
  ctx.restore();
}

function textAnchorX(box, align) {
  if (align === 'center') return box.x + box.w * HALF;
  if (align === 'right' || align === 'end') return box.x + box.w;
  return box.x;
}

function clipTo(ctx, clip) {
  if (!clip) return;
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.w, clip.h);
  ctx.clip();
}

// Offset from a line box top to where the glyphs are drawn. CSS centres the
// font's content area (ascent + descent) in the line box; without font
// metrics, the middle of the line box is the closest match.
function lineOffset(ctx, text) {
  const metrics = ctx.measureText(text.content);
  const ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
    ctx.textBaseline = 'middle';
    return text.lineHeight * HALF;
  }
  ctx.textBaseline = 'alphabetic';
  return (text.lineHeight - ascent - descent) * HALF + ascent;
}

function paintText(ctx, text) {
  const { box } = text;
  ctx.save();
  clipTo(ctx, text.clip);
  ctx.font = text.font;
  ctx.fillStyle = text.color;
  ctx.textAlign = text.align === 'center' || text.align === 'right' || text.align === 'end' ? text.align : 'left';
  const x = textAnchorX(box, text.align);
  const offset = lineOffset(ctx, text);
  const lines = text.wrap === false ? text.content.split('\n')
    : rasterTextLines(ctx, text.content, box.w + WRAP_TOLERANCE_PX);
  for (let index = 0; index < lines.length && index * text.lineHeight < box.h; index++) {
    ctx.fillText(lines[index], x, box.y + index * text.lineHeight + offset);
  }
  ctx.restore();
}

function paintPlate(ctx, plate, images) {
  ctx.save();
  clipTo(ctx, plate.clip);
  ctx.globalAlpha = plate.alpha;
  for (const shadow of plate.shadows) paintShadow(ctx, plate, shadow);
  if (plate.background) {
    ctx.fillStyle = plate.background;
    shapePath(ctx, plate, plate.radius);
    ctx.fill();
  }
  if (plate.image) paintImage(ctx, plate, images.get(plate.image.url));
  if (plate.border) {
    ctx.save();
    paintBorder(ctx, plate);
    ctx.restore();
  }
  if (plate.text) paintText(ctx, plate.text);
  ctx.restore();
}

const firstTileCentre = (offset, pitch) => (((offset % pitch) + pitch) % pitch) - pitch * HALF;

function paintGrid(ctx, { width, height, grid }) {
  ctx.fillStyle = grid.color;
  for (let y = firstTileCentre(grid.offsetY, grid.pitch); y - grid.radius < height; y += grid.pitch) {
    if (y + grid.radius <= 0) continue;
    for (let x = firstTileCentre(grid.offsetX, grid.pitch); x - grid.radius < width; x += grid.pitch) {
      if (x + grid.radius <= 0) continue;
      ctx.beginPath();
      ctx.arc(x, y, grid.radius, 0, FULL_CIRCLE_RAD);
      ctx.fill();
    }
  }
}

/** Paint a measured scene: background, grid dots, then every plate in DOM order. */
export function paintScene(ctx, scene, images) {
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, scene.width, scene.height);
  if (scene.grid) paintGrid(ctx, scene);
  for (const plate of scene.plates) paintPlate(ctx, plate, images);
}
