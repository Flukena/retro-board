const IMAGE_TYPE = 'image';

/** `[{ id, src }]` for every image item that has a string source. */
export function listImageSources(yItems) {
  const images = [];
  yItems.forEach((yItem, id) => {
    const src = yItem.get?.('src');
    if (yItem.get?.('type') === IMAGE_TYPE && typeof src === 'string') images.push({ id, src });
  });
  return images;
}

/**
 * Rewrites image sources in ONE local transaction. `replacements` maps an old source to its new one; an item
 * whose source changed in the meantime is left alone. Returns how many items were rewritten.
 */
export function rewriteImageSources(ydoc, yItems, replacements, origin) {
  let rewritten = 0;
  ydoc.transact(() => {
    yItems.forEach((yItem) => {
      const next = yItem.get?.('type') === IMAGE_TYPE ? replacements.get(yItem.get('src')) : undefined;
      if (next === undefined) return;
      yItem.set('src', next);
      rewritten += 1;
    });
  }, origin);
  return rewritten;
}
