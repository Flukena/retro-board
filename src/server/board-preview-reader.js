import { boardPreviewFromItems } from '../domain/board-preview.js';

const ITEMS_MAP = 'items';

// The relay builds its docs with the CommonJS copy of Yjs, so `instanceof Y.Map` from this ES module would never match;
// a Y.Map is recognised by its shape instead (as public-wall-snapshot does).
const isYMap = (value) => typeof value?.get === 'function' && typeof value.toJSON === 'function';

function* plainItemsOf(doc) {
  for (const value of doc.getMap(ITEMS_MAP).values()) {
    if (isYMap(value)) yield value.toJSON();
  }
}

/** Zone rectangles and colour indexes of a board doc, or null when it has none. Never carries any text. */
export const boardPreviewOfDoc = (doc) => boardPreviewFromItems(plainItemsOf(doc));
