import * as Y from 'yjs';
import { DRAWING_BROADCAST_INTERVAL_MS, readDrawingPreview } from '../../domain/drawing-preview.js';

const PREVIEW_ORIGIN = 'drawing-preview';
const EMPTY_PREVIEWS = Object.freeze([]);
const samePoint = (left, right) => left?.x === right?.x && left?.y === right?.y;
function syncPoints(points, next) {
  let common = 0;
  while (common < points.length && common < next.length && samePoint(points.get(common), next[common])) common++;
  if (common < points.length) points.delete(common, points.length - common);
  if (common < next.length) points.push(next.slice(common));
}
function syncStrokes(array, strokes) {
  if (array.length > strokes.length) array.delete(strokes.length, array.length - strokes.length);
  strokes.forEach((stroke, index) => {
    let target = array.get(index);
    if (!(target instanceof Y.Map)) {
      target = new Y.Map(); target.set('points', new Y.Array()); array.insert(index, [target]);
    }
    for (const field of ['tool', 'color', 'width']) {
      const value = stroke[field] ?? 'pen';
      if (target.get(field) !== value) target.set(field, value);
    }
    syncPoints(target.get('points'), stroke.points);
  });
}
export function createDrawingPreviews(doc, awareness) {
  const items = doc.getMap('items'), targetWatchers = new Map();
  const map = doc.getMap('__drawingPreviews'), key = String(doc.clientID), listeners = new Set(), cache = new Map();
  let timer = null, pending = null, snapshot = EMPTY_PREVIEWS, destroyed = false;
  function notify() {
    const next = [];
    map.forEach((record, owner) => {
      if (owner === key || !awareness.getStates().has(Number(owner)) || !(record instanceof Y.Map)) return;
      const cached = cache.get(owner);
      const value = cached?.record === record ? cached.value : readDrawingPreview(record.toJSON());
      cache.set(owner, { record, value });
      const target = value?.targetId ? items.get(value.targetId) : null;
      if (value && (!value.targetId || (target instanceof Y.Map && target.get('type') === 'image'))) next.push(value);
    });
    for (const owner of cache.keys()) if (!map.has(owner) || !awareness.getStates().has(Number(owner))) cache.delete(owner);
    snapshot = next.length ? next : EMPTY_PREVIEWS;
    listeners.forEach(listener => listener());
  }
  function flush() {
    if (timer !== null) clearTimeout(timer); timer = null;
    if (destroyed || !pending) return;
    const source = pending; pending = null;
    const value = readDrawingPreview(typeof source === 'function' ? source() : source);
    if (!value) { clear(); return; }
    doc.transact(() => {
      let record = map.get(key);
      if (!(record instanceof Y.Map) || record.get('id') !== value.id) {
        record = new Y.Map(); record.set('strokes', new Y.Array()); map.set(key, record);
      }
      for (const field of ['id', 'targetId', 'base']) {
        if (JSON.stringify(record.get(field)) !== JSON.stringify(value[field])) record.set(field, value[field]);
      }
      syncStrokes(record.get('strokes'), value.strokes);
    }, PREVIEW_ORIGIN);
  }
  function clear() {
    if (timer !== null) clearTimeout(timer); timer = null; pending = null;
    if (map.has(key)) doc.transact(() => map.delete(key), PREVIEW_ORIGIN);
  }
  function changed(events) {
    const owners = new Set(events.flatMap(event => event.path.length ? [event.path[0]] : [...event.keysChanged]));
    owners.delete(key);
    if (!owners.size) return;
    owners.forEach(owner => cache.delete(owner)); notify();
  }
  function itemsChanged(event) {
    notify();
    event.changes.keys.forEach((change, id) => {
      if (change.action === 'delete') [...(targetWatchers.get(id) ?? [])].forEach(listener => listener());
    });
  }
  function membershipChanged({ added, removed }) { if (added.length || removed.length) notify(); }
  items.observe(itemsChanged);
  map.observeDeep(changed); awareness.on('change', membershipChanged); notify();
  return {
    publish(value, immediate = false) {
      if (destroyed) return;
      pending = value;
      if (immediate) flush();
      else if (timer === null) timer = setTimeout(flush, DRAWING_BROADCAST_INTERVAL_MS);
    },
    clear,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    watchTargetDeletion(id, listener) {
      if (!id || destroyed) return () => {};
      let listeners = targetWatchers.get(id);
      if (!listeners) { listeners = new Set(); targetWatchers.set(id, listeners); }
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener) && !listeners.size) targetWatchers.delete(id);
      };
    },
    destroy() {
      clear(); destroyed = true; items.unobserve(itemsChanged); targetWatchers.clear(); map.unobserveDeep(changed); awareness.off('change', membershipChanged); listeners.clear(); cache.clear();
    },
  };
}
