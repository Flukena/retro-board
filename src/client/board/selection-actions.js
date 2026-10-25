export const unlockEntriesForSelection = (items, selectedIds) => (
  items
    .filter((item) => selectedIds.has(item.id) && item.locked === true)
    .map((item) => ({ id: item.id, patch: { locked: false } }))
);
