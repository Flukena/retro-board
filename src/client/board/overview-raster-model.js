import { sizeForPlacement } from '../../domain/board-geometry.js';
import { stickyTextForDom } from '../../domain/security-boundaries.js';
import { CARD_OVERVIEW_ZOOM_MAX, CARD_OVERVIEW_MAX_EDGE_PX, CARD_OVERVIEW_TEXT_MAX_LENGTH } from '../../domain/viewport-limits.js';
import { stickyFontSize } from './sticky-font.js';

const CELL_EDGE_PX = 512;
const MAX_INDEX_CELLS = 64;
const MIN_RASTER_ITEMS = 32;
const MAX_BITMAP_EDGE_PX = 4096;
export const OVERVIEW_RASTER_MAX_PIXELS = 8_388_608;
export const OVERVIEW_RASTER_MAX_DPR = 2;
const MIN_RASTER_SCALE = 0.12;

const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
function cells(rect) {
  const x0 = Math.floor(rect.x / CELL_EDGE_PX), y0 = Math.floor(rect.y / CELL_EDGE_PX);
  const x1 = Math.floor((rect.x + rect.w) / CELL_EDGE_PX), y1 = Math.floor((rect.y + rect.h) / CELL_EDGE_PX);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_INDEX_CELLS) return null;
  const keys = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x}:${y}`);
  return keys;
}
function obstacleIndex(records) {
  const grid = new Map(), large = [];
  for (const record of records) {
    const keys = cells(record);
    if (!keys) { large.push(record); continue; }
    for (const key of keys) {
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(record);
    }
  }
  return { grid, large };
}
function unoccluded(record, index, zones) {
  const nearby = new Set(index.large);
  for (const key of cells(record)) for (const other of index.grid.get(key) || []) nearby.add(other);
  return ![...nearby].some(other => other.id !== record.id && overlaps(record, other))
    && !zones.some(zone => zone.order > record.order && overlaps(record, zone));
}
function rasterRow(record, options) {
  const item = record.item;
  const revealed = options.contexts.get(item.id)?.revealed ?? options.allRevealed;
  const hidden = item.private && item.authorId !== options.userId && !revealed;
  return { id: item.id, x: record.x, y: record.y, w: record.w, h: record.h,
    fontSize: stickyFontSize(item), color: item.fontColor,
    text: hidden ? options.hiddenText : stickyTextForDom(item, false).slice(0, CARD_OVERVIEW_TEXT_MAX_LENGTH) };
}
export function overviewRasterModel(items, options) {
  const records = items.map((item, order) => ({ ...sizeForPlacement(item), x: item.x, y: item.y, id: item.id, item, order }));
  const zones = records.filter(row => row.item.type === 'zone');
  const index = obstacleIndex(records.filter(row => row.item.type !== 'zone'));
  const rows = records.filter(row => row.item.type === 'sticky' && row.w <= CARD_OVERVIEW_MAX_EDGE_PX && row.h <= CARD_OVERVIEW_MAX_EDGE_PX
    && !options.winners.has(row.id) && unoccluded(row, index, zones)).map(row => rasterRow(row, options));
  if (rows.length < MIN_RASTER_ITEMS) return null;
  const x = Math.min(...rows.map(row => row.x)), y = Math.min(...rows.map(row => row.y));
  const w = Math.max(...rows.map(row => row.x + row.w)) - x, h = Math.max(...rows.map(row => row.y + row.h)) - y;
  const scale = Math.min(CARD_OVERVIEW_ZOOM_MAX * Math.min(options.dpr, OVERVIEW_RASTER_MAX_DPR),
    MAX_BITMAP_EDGE_PX / Math.max(w, h), Math.sqrt((options.maxPixels ?? OVERVIEW_RASTER_MAX_PIXELS) / (w * h)));
  if (scale < MIN_RASTER_SCALE) return null;
  return { rows, ids: new Set(rows.map(row => row.id)), bounds: { x, y, w, h }, scale,
    width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

export function overviewPaintRuns(items) {
  const runs = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (item.type === 'sticky' && last?.raster) last.items.push(item);
    else runs.push({ key: item.id, raster: item.type === 'sticky', items: [item] });
  }
  return runs;
}
