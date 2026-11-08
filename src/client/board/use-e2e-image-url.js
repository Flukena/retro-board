import { useEffect, useState } from 'react';
import { resolveE2EImage } from '../room-lock/e2e-images.js';

/**
 * The `blob:` URL of an encrypted-room image (fetch, decrypt, share by source), or null while it loads, when
 * it is broken, or when `src` is null. The URL is revoked once the last card showing it unmounts.
 */
export function useE2EImageUrl(src) {
  const [resolved, setResolved] = useState({ src: null, url: null });
  useEffect(() => {
    if (!src) return undefined;
    let active = true;
    const lease = resolveE2EImage(src);
    lease.url.then((url) => { if (active) setResolved({ src, url }); }, () => {});
    return () => { active = false; lease.release(); };
  }, [src]);
  return resolved.src === src ? resolved.url : null;
}
