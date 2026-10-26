import { parseBoxShadows, paintScene } from './canvas-plates.js';
import { publicImageURL } from './snapshot-image-resource.js';
import { GRID_DOT_RADIUS_PX } from '../board/grid-background.js';
import { PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX, PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX } from '../../domain/public-wall-contract.js';

// Measures the rendered public-wall scene from the live DOM and paints it on a
// canvas. Used for large boards, where converting the DOM itself is too slow.

const TEXT_NODE = 3;
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
// CSS `line-height: normal` is close to 1.2× the font size in browsers.
const NORMAL_LINE_HEIGHT_RATIO = 1.2;
const PRESERVED_WHITE_SPACE = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);
const UNWRAPPED_WHITE_SPACE = new Set(['nowrap', 'pre']);
const PNG_TYPE = 'image/png';

const CONTAINS_PAINT = /\b(paint|strict|content)\b/;

const px = value => Number.parseFloat(value) || 0;
const visibleColor = color => (color && color !== TRANSPARENT && color !== 'transparent' ? color : null);

function radiusOf(style, width, scale) {
  const value = style.borderTopLeftRadius;
  return value.endsWith('%') ? px(value) / 100 * width : px(value) * scale;
}

function borderOf(style, scale) {
  const width = px(style.borderTopWidth);
  const color = visibleColor(style.borderTopColor);
  return width > 0 && style.borderTopStyle !== 'none' && color ? { width: width * scale, color, style: style.borderTopStyle } : null;
}

function directText(element, whiteSpace) {
  const raw = Array.from(element.childNodes).filter(node => node.nodeType === TEXT_NODE).map(node => node.nodeValue).join('');
  return PRESERVED_WHITE_SPACE.has(whiteSpace) ? raw : raw.replace(/\s+/g, ' ').trim();
}

function textOf(element, style, box, scale, clip) {
  const content = directText(element, style.whiteSpace);
  if (!content.trim()) return null;
  const fontSize = px(style.fontSize) * scale;
  const lineHeight = style.lineHeight === 'normal' ? fontSize * NORMAL_LINE_HEIGHT_RATIO : px(style.lineHeight) * scale;
  const left = (px(style.paddingLeft) + px(style.borderLeftWidth)) * scale;
  const top = (px(style.paddingTop) + px(style.borderTopWidth)) * scale;
  const right = (px(style.paddingRight) + px(style.borderRightWidth)) * scale;
  const bottom = (px(style.paddingBottom) + px(style.borderBottomWidth)) * scale;
  return { content, font: `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`, color: style.color,
    lineHeight, align: style.textAlign, clip, wrap: !UNWRAPPED_WHITE_SPACE.has(style.whiteSpace),
    box: { x: box.x + left, y: box.y + top, w: box.w - left - right, h: box.h - top - bottom } };
}

const imageOf = (element, style) => (element.tagName === 'IMG'
  ? { url: publicImageURL(element.getAttribute('src'), element.ownerDocument), fit: style.objectFit }
  : null);

const paints = plate => plate.background || plate.border || plate.shadows.length || plate.text || plate.image;

function intersect(a, b) {
  if (!a) return b;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

const clipsContent = style => style.overflowX !== 'visible' || style.overflowY !== 'visible' || CONTAINS_PAINT.test(style.contain);
const zIndexOf = style => (style.position !== 'static' && style.zIndex !== 'auto' ? Number(style.zIndex) || 0 : 0);
const formsStackingContext = style => (style.position !== 'static' && style.zIndex !== 'auto')
  || px(style.opacity) < 1 || style.transform !== 'none' || style.filter !== 'none'
  || style.isolation === 'isolate' || CONTAINS_PAINT.test(style.contain);

function boxOf(rect, frame) {
  return { x: (rect.left - frame.left) * frame.scale, y: (rect.top - frame.top) * frame.scale,
    w: rect.width * frame.scale, h: rect.height * frame.scale };
}

// What an element passes to its children: opacity, clip and stacking order.
function childContext(parent, style, box, order) {
  return { alpha: parent.alpha * px(style.opacity),
    clip: box && clipsContent(style) ? intersect(parent.clip, box) : parent.clip,
    order: formsStackingContext(style) ? order : parent.order };
}

function plateOf(element, style, frame, context) {
  const rect = element.getBoundingClientRect();
  if (!element.offsetWidth || !rect.width || !rect.height) return { box: null, plate: null };
  const scale = rect.width / element.offsetWidth * frame.scale;
  const box = boxOf(rect, frame);
  const textClip = clipsContent(style) ? intersect(context.clip, box) : context.clip;
  const plate = { ...box, alpha: context.alpha * px(style.opacity), clip: context.clip, radius: radiusOf(style, box.w, scale),
    background: visibleColor(style.backgroundColor), border: borderOf(style, scale),
    shadows: parseBoxShadows(style.boxShadow, scale), text: textOf(element, style, box, scale, textClip),
    image: imageOf(element, style) };
  return { box, plate: paints(plate) ? plate : null };
}

// CSS paint order within nested stacking contexts: by z-index, then document order.
function compareOrder(a, b) {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function gridOf(style) {
  if (style.backgroundImage === 'none') return null;
  const [offsetX, offsetY] = style.backgroundPosition.split(' ').map(px);
  return { color: style.getPropertyValue('--grid-dot').trim(), pitch: px(style.backgroundSize),
    offsetX, offsetY, radius: GRID_DOT_RADIUS_PX };
}

const isHidden = style => style.display === 'none' || style.visibility === 'hidden';

/** Measure the scene element into a paintable description in snapshot pixels. */
export function readScene(root) {
  const view = root.ownerDocument.defaultView;
  const rootRect = root.getBoundingClientRect();
  const frame = { left: rootRect.left, top: rootRect.top, scale: PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX / rootRect.width };
  const rootStyle = view.getComputedStyle(root);
  const contexts = new Map([[root, { alpha: px(rootStyle.opacity), clip: null, order: [] }]]);
  const painted = [];
  Array.from(root.querySelectorAll('*')).forEach((element, index) => {
    const parent = contexts.get(element.parentElement);
    if (!parent || element.closest('svg')) return;
    const style = view.getComputedStyle(element);
    const order = [...parent.order, zIndexOf(style), index];
    if (isHidden(style) || parent.alpha * px(style.opacity) <= 0) return;
    const { box, plate } = plateOf(element, style, frame, parent);
    contexts.set(element, childContext(parent, style, box, order));
    if (plate) painted.push({ plate, order });
  });
  const plates = painted.sort((a, b) => compareOrder(a.order, b.order)).map(entry => entry.plate);
  return { width: PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX, height: PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX,
    background: visibleColor(rootStyle.backgroundColor) || TRANSPARENT, grid: gridOf(rootStyle), plates };
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Board snapshot canvas produced no image'))), PNG_TYPE);
  });
}

/** Paint the scene on a snapshot-sized canvas, with uploaded images loaded the same way as the DOM path. */
export async function renderSceneCanvas(node, { signal, imageResources }) {
  const scene = readScene(node);
  const images = await imageResources.decodedImages(node, signal);
  signal.throwIfAborted();
  const canvas = node.ownerDocument.createElement('canvas');
  canvas.width = scene.width;
  canvas.height = scene.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Board snapshot canvas is unavailable');
  paintScene(ctx, scene, images);
  return canvasBlob(canvas);
}
