import { classifyImportedImageSource } from '../../domain/security-boundaries.js';

const IMAGE_TYPE = 'image';

const isOwnE2ESource = (src, roomHandle) => {
  const source = classifyImportedImageSource(src);
  return source?.kind === 'e2e' && source.roomHandle === roomHandle && source.source === src;
};

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
 * whose source changed in the meantime is left alone. Every original and replacement must be a canonical encrypted
 * source of `roomHandle`, otherwise nothing is written. Returns how many items were rewritten.
 */
export function rewriteImageSources(ydoc, yItems, replacements, origin, roomHandle) {
  for (const [from, to] of replacements) {
    if (!isOwnE2ESource(from, roomHandle) || !isOwnE2ESource(to, roomHandle)) {
      throw new RangeError('image rewrite needs encrypted sources of this room');
    }
  }
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
