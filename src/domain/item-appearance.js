import { IMPORT_FONT_SIZE_MAX } from './security-boundaries.js';
import { effectiveZIndex } from './z-order.js';

export const isValidFontSize = (value) => (
  Number.isFinite(value) && value > 0 && value <= IMPORT_FONT_SIZE_MAX
);

export const isValidFontColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

export const isValidZIndex = (value, maxAbs = Number.MAX_SAFE_INTEGER) => (
  Number.isFinite(value) && Math.abs(value) <= maxAbs
);

/**
 * @param {{fontSize?:unknown, fontColor?:unknown, zIndex?:unknown, createdAt?:unknown}} record
 * @returns {{fontSize?:number, fontColor?:string, zIndex?:number}}
 */
export const safeSnapshotAppearance = (record) => {
  const appearance = {};
  if (isValidFontSize(record.fontSize)) appearance.fontSize = record.fontSize;
  if (isValidFontColor(record.fontColor)) appearance.fontColor = record.fontColor.toLowerCase();
  const zIndex = effectiveZIndex(record);
  if (isValidZIndex(zIndex)) appearance.zIndex = zIndex;
  return appearance;
};
