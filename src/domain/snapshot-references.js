function sameRecordFields(previous, next) {
  if (previous === next) return true;
  if (!previous || !next) return false;
  const keys = Object.keys(next);
  return keys.length === Object.keys(previous).length
    && keys.every(key => Object.hasOwn(previous, key) && Object.is(previous[key], next[key]));
}

// Indexed vote Sets and comment arrays are replaced on change by the Yjs adapter.
export function reuseSnapshotMap(previous, next) {
  if (previous.size !== next.size) return next;
  for (const [key, value] of next) {
    if (!previous.has(key) || !Object.is(previous.get(key), value)) return next;
  }
  return previous;
}

export function reuseBoardReferences(previous, next) {
  const previousById = new Map(previous.items.map(item => [item.id, item]));
  const sharedItems = next.items.map(item => {
    const old = previousById.get(item.id);
    return sameRecordFields(old, item) ? old : item;
  });
  const sameOrder = sharedItems.length === previous.items.length
    && sharedItems.every((item, index) => item === previous.items[index]);
  const shared = { ...next, items: sameOrder ? previous.items : sharedItems };
  return sameRecordFields(previous, shared) ? previous : shared;
}
