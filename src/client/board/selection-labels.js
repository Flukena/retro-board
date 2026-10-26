// One "is selecting" label per person, pinned to the top-left of the cards
// they selected, so stacked cards do not pile up labels that cover them.
export function remoteSelectionLabels(items, selectorsByItem) {
  const groups = new Map();
  for (const item of items) {
    const selector = item.type === 'zone' ? null : selectorsByItem.get(item.id);
    if (!selector) continue;
    const key = `${selector.userId}:${selector.extraCount}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.x = Math.min(group.x, item.x);
      group.y = Math.min(group.y, item.y);
    } else {
      groups.set(key, { key, selector, count: 1, x: item.x, y: item.y });
    }
  }
  return [...groups.values()];
}

export function selectionLabelMessage({ selector, count }) {
  if (selector.extraCount > 0) return ['selection.byMany', { name: selector.name, n: selector.extraCount }];
  if (count > 1) return ['selection.byCount', { name: selector.name, n: count }];
  return ['selection.by', { name: selector.name }];
}
