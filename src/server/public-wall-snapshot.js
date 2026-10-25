import { isSafeId } from '../domain/comment-schema.js';
import { geometryErrorForItem } from '../domain/board-geometry.js';
import { PUBLIC_ITEM_TYPES, PUBLIC_TEXT_MAX_CHARACTERS, PUBLIC_MAX_ITEMS, PUBLIC_SNAPSHOT_INTERVAL_MS } from '../domain/public-wall-contract.js';
import { safeSnapshotAppearance } from '../domain/item-appearance.js';
import { canonicalPublicImageSource } from '../domain/public-wall-image-source.js';

const SNAPSHOT_GEOMETRY_FIELDS = ['x', 'y', 'w', 'h'];
const plainText = value => typeof value === 'string' ? value : value?.toString?.();

function snapshotGeometry(source, id, type) {
  const item = { id, type };
  for (const field of SNAPSHOT_GEOMETRY_FIELDS) {
    if (source.has(field)) item[field] = source.get(field);
  }
  return item;
}

function snapshotText(source, type) {
  // Private text is never advertised on the unauthenticated landing preview.
  if (type === 'image' || (type === 'sticky' && source.get('private') === true)) return '';
  const value = plainText(source.get(type === 'zone' ? 'title' : 'text'));
  return typeof value === 'string' ? value.slice(0, PUBLIC_TEXT_MAX_CHARACTERS) : '';
}

export function publicWallSnapshot(doc, { roomHandle } = {}) {
  const items = [];
  doc.getMap('items').forEach((source, id) => {
    if (items.length >= PUBLIC_MAX_ITEMS || !isSafeId(id) || typeof source?.get !== 'function') return;
    const type = source.get('type');
    if (!PUBLIC_ITEM_TYPES.includes(type)) return;
    const item = snapshotGeometry(source, id, type);
    if (geometryErrorForItem(item)) return;
    if (type === 'image') {
      const src = canonicalPublicImageSource(source.get('src'), roomHandle);
      if (!src) return;
      item.src = src;
    }
    const color = source.get('color');
    if (Number.isSafeInteger(color)) item.color = color;
    Object.assign(item, safeSnapshotAppearance({
      fontSize: source.get('fontSize'), fontColor: source.get('fontColor'),
      zIndex: source.get('zIndex'), createdAt: source.get('createdAt'),
    }));
    item.text = snapshotText(source, type);
    items.push(item);
  });
  return { items };
}

export class PublicSnapshotCache {
  #doc = null;
  #dirty = true;
  #value = null;
  #generatedAtMs = -Infinity;
  #changed = () => { this.#dirty = true; };
  #roomHandle;

  constructor({ roomHandle } = {}) {
    this.#roomHandle = roomHandle;
  }

  read(doc, nowMs = Date.now()) {
    if (doc !== this.#doc) {
      this.#doc?.off('update', this.#changed);
      this.#doc = doc;
      doc.on('update', this.#changed);
      this.#dirty = true;
    }
    if (!this.#value || (this.#dirty && nowMs - this.#generatedAtMs >= PUBLIC_SNAPSHOT_INTERVAL_MS)) {
      this.#value = publicWallSnapshot(doc, { roomHandle: this.#roomHandle });
      this.#generatedAtMs = nowMs;
      this.#dirty = false;
    }
    return this.#value;
  }
}
