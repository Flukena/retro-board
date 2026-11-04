import { ACTION_FIELD, isActionItem } from '../../domain/action-item.js';
import { sizeForPlacement } from '../../domain/board-geometry.js';
import { isStickyHiddenForUser } from '../../domain/board-visibility.js';
import { compareZOrder } from '../../domain/z-order.js';
import { fontSizeForItem } from '../board/selection-toolbar-model.js';
import { PALETTE, STICKY_AUTO_TEXT } from '../ui/palette.js';

// Board image export: a paintScene() scene built from the item model, so cards
// that are off screen (and therefore not in the DOM) still appear.
export const EXPORT_PADDING_PX = 48;
export const EXPORT_PREFERRED_SCALE = 2;
export const EXPORT_MAX_EDGE_PX = 16_384;
// WebKit refuses canvases above 16,777,216 pixels.
export const EXPORT_MAX_PIXELS = 16_777_216;

const TEXT_LINE_HEIGHT_RATIO = 1.35;
const STICKY_PADDING_PX = 14;
const STICKY_FOOTER_HEIGHT_PX = 28;
const STICKY_FOOTER_FONT_PX = 12;
const STICKY_RADIUS_PX = 8;
const STICKY_BORDER_PX = 1;
const ZONE_RADIUS_PX = 12;
const ZONE_BORDER_PX = 2;
const ZONE_TITLE_INSET_PX = 14;
const ZONE_TITLE_WEIGHT = 600;
const TEXT_WEIGHT = 400;
const OPAQUE = 1;

/** World-space box that encloses every item, or null for an empty board. */
export function boardImageBounds(items) {
  if (!items.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    const { w, h } = sizeForPlacement(item);
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + w);
    maxY = Math.max(maxY, item.y + h);
  }
  return { x: minX - EXPORT_PADDING_PX, y: minY - EXPORT_PADDING_PX,
    w: maxX - minX + EXPORT_PADDING_PX * 2, h: maxY - minY + EXPORT_PADDING_PX * 2 };
}

/** Largest scale up to the preferred one that keeps the canvas within browser limits. */
export function boardImageScale(bounds, { preferred = EXPORT_PREFERRED_SCALE, maxEdge = EXPORT_MAX_EDGE_PX, maxPixels = EXPORT_MAX_PIXELS } = {}) {
  const byEdge = maxEdge / Math.max(bounds.w, bounds.h);
  const byArea = Math.sqrt(maxPixels / (bounds.w * bounds.h));
  return Math.min(preferred, byEdge, byArea);
}

const font = (weight, sizePx, family) => `normal ${weight} ${sizePx}px ${family}`;

function textBlock({ content, box, sizePx, family, color, weight = TEXT_WEIGHT, align = 'left', wrap = true }) {
  return { content, font: font(weight, sizePx, family), color, lineHeight: sizePx * TEXT_LINE_HEIGHT_RATIO,
    align, clip: box, wrap, box };
}

function plate(box, fields = {}) {
  return { ...box, alpha: OPAQUE, clip: null, radius: 0, shadows: [], background: null, border: null,
    text: null, image: null, ...fields };
}

function zonePlates(zone, frame, look) {
  const box = frame.box(zone);
  const colors = PALETTE[zone.color] || PALETTE[0];
  const s = frame.scale;
  const titleSize = fontSizeForItem(zone) * s;
  const inset = ZONE_TITLE_INSET_PX * s;
  const titleBox = { x: box.x + inset, y: box.y + inset, w: box.w - inset * 2, h: titleSize * TEXT_LINE_HEIGHT_RATIO };
  return [plate(box, {
    radius: ZONE_RADIUS_PX * s, background: colors.zoneBg,
    border: { width: ZONE_BORDER_PX * s, color: colors.border, style: 'solid' },
  }), plate(titleBox, {
    text: zone.title ? textBlock({ content: zone.title, box: titleBox, sizePx: titleSize, family: look.displayFont,
      color: colors.ink, weight: ZONE_TITLE_WEIGHT, wrap: false }) : null,
  })];
}

function actionBadge(sticky, hidden, labels) {
  if (!isActionItem(sticky)) return '';
  return labels.actionBadge({ done: sticky[ACTION_FIELD.DONE] === true,
    owner: hidden ? '' : sticky[ACTION_FIELD.OWNER] || '', due: sticky[ACTION_FIELD.DUE] || '' });
}

function stickyPlates(sticky, frame, context) {
  const { look, labels } = context;
  const box = frame.box(sticky);
  const colors = PALETTE[sticky.color] || PALETTE[0];
  const s = frame.scale;
  const hidden = isStickyHiddenForUser(sticky, context.items, context.allRevealed, context.userId);
  const pad = STICKY_PADDING_PX * s;
  const footerH = STICKY_FOOTER_HEIGHT_PX * s;
  const footerSize = STICKY_FOOTER_FONT_PX * s;
  const badge = actionBadge(sticky, hidden, labels);
  const badgeH = badge ? footerSize * TEXT_LINE_HEIGHT_RATIO : 0;
  const badgeBox = { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: badgeH };
  const textBox = { x: box.x + pad, y: badgeBox.y + badgeH, w: box.w - pad * 2, h: Math.max(0, box.h - pad - badgeH - footerH) };
  const footerBox = { x: box.x + pad, y: box.y + box.h - footerH, w: box.w - pad * 2, h: footerH };
  const votes = context.votesByItem.get(sticky.id)?.size ?? 0;
  const footer = (align, content) => plate(footerBox, { text: textBlock({ content, box: footerBox, sizePx: footerSize,
    family: look.uiFont, color: colors.ink, align, wrap: false }) });
  return [
    plate(box, { radius: STICKY_RADIUS_PX * s, background: colors.bg,
      border: { width: STICKY_BORDER_PX * s, color: colors.border, style: 'solid' } }),
    ...(badge ? [plate(badgeBox, { text: textBlock({ content: badge, box: badgeBox, sizePx: footerSize, family: look.uiFont,
      color: colors.ink, wrap: false }) })] : []),
    plate(textBox, { text: textBlock({ content: hidden ? labels.hidden : String(sticky.text ?? ''), box: textBox,
      sizePx: fontSizeForItem(sticky) * s, family: look.displayFont, color: sticky.fontColor || STICKY_AUTO_TEXT }) }),
    ...(!hidden && sticky.authorName ? [footer('left', sticky.authorName)] : []),
    ...(votes > 0 ? [footer('right', labels.votes(votes))] : []),
  ];
}

function textCardPlates(item, frame, look) {
  const box = frame.box(item);
  return [plate(box, { text: textBlock({ content: String(item.text ?? ''), box, sizePx: fontSizeForItem(item) * frame.scale,
    family: look.displayFont, color: item.fontColor || look.text }) })];
}

const imagePlates = (item, frame) => (item.src ? [plate(frame.box(item), { image: { url: item.src, fit: 'contain' } })] : []);

const PLATES_BY_TYPE = Object.freeze({
  zone: (item, frame, context) => zonePlates(item, frame, context.look),
  sticky: stickyPlates,
  text: (item, frame, context) => textCardPlates(item, frame, context.look),
  image: imagePlates,
});

/** Zones paint underneath everything else, each layer in board z-order. */
export const paintOrder = (items) => [
  ...items.filter(item => item.type === 'zone').sort(compareZOrder),
  ...items.filter(item => item.type !== 'zone').sort(compareZOrder),
];

/**
 * Scene for paintScene(): one plate per painted part, in board z-order.
 * `look` carries resolved theme tokens; `labels` carries translated text.
 */
export function buildBoardImageScene({ items, votesByItem, userId, allRevealed, look, labels, bounds, scale }) {
  const frame = {
    scale,
    box: (item) => {
      const { w, h } = sizeForPlacement(item);
      return { x: (item.x - bounds.x) * scale, y: (item.y - bounds.y) * scale, w: w * scale, h: h * scale };
    },
  };
  const context = { items, votesByItem, userId, allRevealed, look, labels };
  const plates = paintOrder(items).flatMap(item => PLATES_BY_TYPE[item.type]?.(item, frame, context) ?? []);
  return { width: Math.ceil(bounds.w * scale), height: Math.ceil(bounds.h * scale), background: look.background, grid: null, plates };
}

/** Every image URL the scene needs decoded before painting. */
export const sceneImageUrls = (scene) => [...new Set(scene.plates.filter(entry => entry.image).map(entry => entry.image.url))];
