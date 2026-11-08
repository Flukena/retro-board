import { isE2EImageSource } from '../../domain/security-boundaries.js';
import { getRoomKey } from './lock-session.js';
import { RoomKeyError } from './e2e-crypto.js';
import { isKnownCurrentEpoch, readE2EImage, uploadEncryptedImage } from './e2e-images.js';

const ownImageSources = (storage, key) => [...new Set(storage.listImageSources().map(({ src }) => src))]
  .filter((src) => isE2EImageSource(src) && src.startsWith(`/rooms/${key.roomHandle}/`) && !isKnownCurrentEpoch(src, key));

/**
 * After a key rotation: every image only an earlier key opens is re-encrypted under the current key with a new
 * id, uploaded, and all its items are rewritten in one local transaction (an item whose source changed meanwhile
 * is left alone). Earlier keys are never dropped: late replay and undo can still bring old references back, and
 * the key must stay until the page reloads. An image no held key opens is counted as broken; a transport failure is counted as failed so the scheduler tries again.
 */
export async function repairOldEpochImagesOnce({ storage, key = getRoomKey() }) {
  if (!key?.previousKeys?.size) return { repaired: 0, broken: 0, failed: 0 };
  const rewrites = new Map();
  let broken = 0;
  let failed = 0;
  for (const src of ownImageSources(storage, key)) {
    try {
      const image = await readE2EImage(src, { key });
      if (image.epoch !== key.keyEpoch) rewrites.set(src, await uploadEncryptedImage(image.blob, { key }));
    } catch (error) {
      if (error instanceof RoomKeyError) broken += 1;
      else failed += 1;
    }
  }
  return { repaired: rewrites.size > 0 ? storage.rewriteImageSources(rewrites) : 0, broken, failed };
}

let active = null;
let rerun = false;

/** At most one repair runs at a time; a request made meanwhile makes it run once more afterwards. */
export function repairOldEpochImages(options) {
  if (active) {
    rerun = true;
    return active;
  }
  active = (async () => {
    let result;
    do {
      rerun = false;
      result = await repairOldEpochImagesOnce(options);
      if (result.broken > 0) console.warn('[e2e] images that no held key opens', result.broken);
    } while (rerun);
    return result;
  })().finally(() => { active = null; });
  return active;
}
