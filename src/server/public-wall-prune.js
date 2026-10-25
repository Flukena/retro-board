import { PUBLIC_MAX_ITEMS } from '../domain/public-wall-contract.js';
import { PUBLIC_PRUNE_ORIGIN, PUBLIC_CREATED_AT_CLOCK_SKEW_MS } from './public-wall-config.js';

// createdAt is client supplied. Missing/invalid/far-future dates are oldest; ID breaks ties
// independently of Y.Map insertion order (which differs between replicas).
const createdAtMs = (item, nowMs) => {
  const value = typeof item?.get === 'function' ? item.get('createdAt') : null;
  return Number.isSafeInteger(value) && value >= 0 && value <= nowMs + PUBLIC_CREATED_AT_CLOCK_SKEW_MS ? value : 0;
};
const oldestFirst = (left, right) => (
  left.createdAt - right.createdAt || (left.id < right.id ? -1 : Number(left.id > right.id))
);

export function prunePublicWall(doc, maxItems = PUBLIC_MAX_ITEMS, nowMs = Date.now()) {
  const items = doc.getMap('items');
  const excessCount = items.size - maxItems;
  if (excessCount <= 0) return 0;
  const oldest = [...items].map(([id, item]) => ({ id, createdAt: createdAtMs(item, nowMs) }))
    .sort(oldestFirst).slice(0, excessCount);
  doc.transact(() => oldest.forEach(({ id }) => items.delete(id)), PUBLIC_PRUNE_ORIGIN);
  return oldest.length;
}
