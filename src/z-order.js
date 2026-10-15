export const effectiveZIndex = (item) => item.zIndex ?? item.createdAt;
export const compareZOrder = (a, b) => {
  const delta = effectiveZIndex(a) - effectiveZIndex(b);
  if (delta) return delta;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
};

const valuesForTiedRange = (reordered, lowerZ, upperZ, lowerGroupZ, upperGroupZ) => {
  if (lowerZ != null && upperZ != null) {
    const step = (upperZ - lowerZ) / (reordered.length + 1);
    return reordered.map((_, i) => lowerZ + step * (i + 1));
  }
  if (lowerZ != null) {
    return reordered.map((_, i) => lowerGroupZ + i);
  }
  if (upperZ != null) {
    return reordered.map((_, i) => upperGroupZ - (reordered.length - i - 1));
  }
  return reordered.map((_, i) => i);
};

const zValuesAreOrdered = (values, lowerZ, upperZ) => values.every((value, i) => (
  Number.isFinite(value)
  && (i === 0 || value > values[i - 1])
  && (lowerZ == null || value > lowerZ)
  && (upperZ == null || value < upperZ)
));

export const swapZOrderEntries = (items, index, neighborIndex) => {
  const itemZ = effectiveZIndex(items[index]);
  const neighborZ = effectiveZIndex(items[neighborIndex]);
  const lowerIndex = Math.min(index, neighborIndex);
  const upperIndex = Math.max(index, neighborIndex);
  const lowerGroupZ = effectiveZIndex(items[lowerIndex]);
  const upperGroupZ = effectiveZIndex(items[upperIndex]);
  const touchesTie = lowerGroupZ === upperGroupZ
    || (lowerIndex > 0 && effectiveZIndex(items[lowerIndex - 1]) === lowerGroupZ)
    || (upperIndex < items.length - 1
      && effectiveZIndex(items[upperIndex + 1]) === upperGroupZ);
  if (!touchesTie) {
    return [
      { id: items[index].id, patch: { zIndex: neighborZ } },
      { id: items[neighborIndex].id, patch: { zIndex: itemZ } },
    ];
  }

  // Items created in one batch can share a millisecond timestamp. A raw swap
  // can then be a no-op or cross extra peers in that tie, so give the smallest
  // affected tied range distinct values while preserving all other positions.
  let first = lowerIndex;
  let last = upperIndex;
  while (first > 0 && effectiveZIndex(items[first - 1]) === lowerGroupZ) first -= 1;
  while (last < items.length - 1
    && effectiveZIndex(items[last + 1]) === upperGroupZ) last += 1;

  const reordered = items.slice(first, last + 1);
  const localIndex = index - first;
  const localNeighborIndex = neighborIndex - first;
  [reordered[localIndex], reordered[localNeighborIndex]] = [
    reordered[localNeighborIndex],
    reordered[localIndex],
  ];

  const lowerZ = first > 0 ? effectiveZIndex(items[first - 1]) : null;
  const upperZ = last < items.length - 1 ? effectiveZIndex(items[last + 1]) : null;
  const values = valuesForTiedRange(reordered, lowerZ, upperZ, lowerGroupZ, upperGroupZ);

  if (zValuesAreOrdered(values, lowerZ, upperZ)) {
    return reordered.map((item, i) => ({ id: item.id, patch: { zIndex: values[i] } }));
  }

  // Floating-point values can theoretically leave no representable gap.
  // Reindexing the whole already-sorted stack is the deterministic fallback.
  const fullyReordered = [...items];
  [fullyReordered[index], fullyReordered[neighborIndex]] = [
    fullyReordered[neighborIndex],
    fullyReordered[index],
  ];
  return fullyReordered.map((item, i) => ({ id: item.id, patch: { zIndex: i } }));
};

