import { boardPreviewFromItems } from '../domain/board-preview.js';

const ITEMS_MAP = 'items';
const ZONE_TYPE = 'zone';
const ZONE_PREVIEW_FIELDS = Object.freeze(['x', 'y', 'w', 'h', 'color']);

// The relay builds its docs with the CommonJS copy of Yjs, so `instanceof Y.Map` from this ES module would never match;
// an item is read through its `get` method instead, as public-wall-snapshot does.
const hasGetMethod = (value) => typeof value?.get === 'function';

// Only zones are read, and only the fields a preview keeps; no item is copied whole.
function* zoneItemsOf(doc) {
  for (const value of doc.getMap(ITEMS_MAP).values()) {
    if (hasGetMethod(value) && value.get('type') === ZONE_TYPE) {
      yield Object.fromEntries([['type', ZONE_TYPE], ...ZONE_PREVIEW_FIELDS.map((field) => [field, value.get(field)])]);
    }
  }
}

/** Zone rectangles and colour indexes of a board doc, or null when it has none. Never carries any text. */
export const boardPreviewOfDoc = (doc) => boardPreviewFromItems(zoneItemsOf(doc));
