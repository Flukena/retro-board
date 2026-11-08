import { useEffect, useState } from 'react';
import { resolveE2EImage } from '../room-lock/e2e-images.js';
import { createImageUrlSlot } from './e2e-image-url-slot.js';

/**
 * The `blob:` URL of an encrypted-room image (fetch, decrypt, share by source), or null while it loads, when it
 * is broken, or when `src` is null. The URL is revoked once the last card showing it unmounts.
 */
export function useE2EImageUrl(src) {
  const [resolved, setResolved] = useState({ src: null, url: null });
  useEffect(() => {
    const slot = createImageUrlSlot({ resolve: resolveE2EImage, onChange: setResolved });
    slot.setSrc(src);
    return slot.dispose;
  }, [src]);
  return resolved.src === src ? resolved.url : null;
}
