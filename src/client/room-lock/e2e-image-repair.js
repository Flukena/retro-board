import { isE2EImageSource } from '../../domain/security-boundaries.js';
import { dropPreviousKey, getRoomKey } from './lock-session.js';
import { RoomKeyError } from './e2e-crypto.js';
import { readE2EImage, uploadEncryptedImage } from './e2e-images.js';

const ownImageSources = (storage, roomHandle) => [...new Set(storage.listImageSources().map(({ src }) => src))]
  .filter((src) => isE2EImageSource(src) && src.startsWith(`/rooms/${roomHandle}/`));

/**
 * After a key rotation: every image only an earlier key opens is re-encrypted under the current key with a new
 * id, uploaded, and all its items are rewritten in one local transaction. Then the keys of epochs that no image
 * still needs are dropped. An image no held key opens is counted as broken; a transport failure keeps every key
 * so a later run can still repair it.
 */
export async function repairOldEpochImagesOnce({ storage, key = getRoomKey(), dropKey = dropPreviousKey }) {
  const previousEpochs = [...(key?.previousKeys?.keys() ?? [])];
  if (previousEpochs.length === 0) return { repaired: 0, broken: 0 };
  const rewrites = new Map();
  const unfinishedEpochs = new Set();
  let broken = 0;
  let transportFailed = false;
  for (const src of ownImageSources(storage, key.roomHandle)) {
    let epoch = null;
    try {
      const image = await readE2EImage(src, { key });
      ({ epoch } = image);
      if (epoch === key.keyEpoch) continue;
      rewrites.set(src, await uploadEncryptedImage(image.blob, { key }));
    } catch (error) {
      if (error instanceof RoomKeyError) broken += 1;
      else transportFailed = true;
      if (epoch !== null) unfinishedEpochs.add(epoch);
    }
  }
  const repaired = rewrites.size > 0 ? storage.rewriteImageSources(rewrites) : 0;
  if (!transportFailed) previousEpochs.filter((epoch) => !unfinishedEpochs.has(epoch)).forEach(dropKey);
  return { repaired, broken };
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
