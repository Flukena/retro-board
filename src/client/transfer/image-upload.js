import { IMAGE_MAX_BYTES, imageInfoIsWithinLimits, inspectRasterImageBlob, isE2EImageSource, isSafeImageMime, resolveRoomImageSource } from '../../domain/security-boundaries.js';
import { getActiveRoomSession, getRelayHttpBaseUrl, roomFetch } from '../session/room-session.js';
import { canonicalPublicImageSource } from '../../domain/public-wall-image-source.js';
import { restoreBackupImages } from './backup-images.js';
import { canvasToBlob, decodedDimensionsMatch, drawBoundedCanvas, encodeImageCanvas, withDecodedImage } from './image-canvas.js';
import { decryptImageResponse } from '../room-lock/e2e-images.js';
import { getRoomKey } from '../room-lock/lock-session.js';

const BYTES_PER_MIB = 1_048_576;
export const IMAGE_MAX_MIB_LABEL = (IMAGE_MAX_BYTES / BYTES_PER_MIB).toFixed(0);

const IMAGE_RETRY_ATTEMPTS = 6;
const IMAGE_RETRY_DELAY_MS = 1100;
const RATE_LIMIT_STATUS = 429;
const MIME_GIF = 'image/gif';
const ROOM_IMAGE_ROUTE = /^\/(?:(?:yjs|yjs-public)\/)?rooms\/[A-Za-z0-9_-]{32}\/((?:images|e2e-blobs)\/[^/]+)$/;
const UPLOAD_RATE_LIMIT_ERROR = /: 429$/;
const delayImageRetry = () => new Promise((resolve) => { setTimeout(resolve, IMAGE_RETRY_DELAY_MS); });

/** Whether the room's creation quota (Public Wall only) has room for one more image item. */
export const canCreateImageItem = storage => !storage?.canCreateItems || storage.canCreateItems([{ type: 'image' }]);

export function canStartImageImport(blob, storage) {
  if (!blob?.type?.startsWith('image/')) return false;
  if (!isSafeImageMime(blob.type) || blob.size > IMAGE_MAX_BYTES) return true;
  return canCreateImageItem(storage);
}

export const safeRuntimeImageSource = (value, { publicPreview = false } = {}) => {
  if (publicPreview) return canonicalPublicImageSource(value);
  if (typeof window === 'undefined') return null;
  const roomHandle = getActiveRoomSession()?.roomHandle;
  return resolveRoomImageSource(value, {
    pageOrigin: window.location.origin,
    relayBaseUrl: getRelayHttpBaseUrl(),
    roomHandle,
  }, getRoomKey()?.roomHandle ?? null);
};

export { canvasToBlob };

// Inspect headers before decode so malformed/decompression-bomb inputs are
// rejected early. PNG/JPEG/WebP are always redrawn through a bounded canvas,
// which strips EXIF and other metadata. GIFs retain animation only after a
// full structural/frame-budget check in inspectRasterImageBlob.
export const prepareImageBlob = async (blob) => {
  const info = await inspectRasterImageBlob(blob);
  if (!imageInfoIsWithinLimits(info)) return null;
  return withDecodedImage(blob, async (img) => {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    // Browser JPEG orientation may swap the header dimensions.
    if (!decodedDimensionsMatch(nw, nh, info)) return null;
    if (info.mime === MIME_GIF) return { blob, nw, nh };
    const drawn = drawBoundedCanvas(img, nw, nh);
    if (!drawn) return null;
    const finalBlob = await encodeImageCanvas(drawn.canvas, info.mime);
    return finalBlob ? { blob: finalBlob, nw: drawn.width, nh: drawn.height } : null;
  });
};

// Read only validated image routes. Room reads refresh the authenticated
// session through the same transport as uploads.
export const readBackupImage = async (source, { signal } = {}) => {
  const src = safeRuntimeImageSource(source);
  if (!src) throw new Error('image belongs to another room or server');
  const encrypted = isE2EImageSource(src);
  const path = encrypted ? src : new URL(src).pathname;
  const roomImage = path.match(ROOM_IMAGE_ROUTE);
  for (let attempt = 0; attempt < IMAGE_RETRY_ATTEMPTS; attempt += 1) {
    const response = roomImage
      ? await roomFetch(roomImage[1], { signal })
      : await fetch(src, { signal, credentials: 'include', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (response.ok) return encrypted ? (await decryptImageResponse(response, src)).blob : response.blob();
    const status = response.status;
    await response.body?.cancel();
    if (status !== RATE_LIMIT_STATUS || attempt === IMAGE_RETRY_ATTEMPTS - 1) throw new Error(`image read failed: ${status}`);
    await delayImageRetry();
  }
};

// Server 429s ("image upload failed: 429") when the per-IP upload bucket is
// exhausted — re-uploading many legacy images back to back can hit this.
// Any other failure (bad format, network) won't fix itself on retry.
export const uploadWithRetry = async (blob, attempts = IMAGE_RETRY_ATTEMPTS, options = {}) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await window.storage.uploadImage(blob, options);
    } catch (err) {
      if (i === attempts - 1 || !UPLOAD_RATE_LIMIT_ERROR.test(err.message)) throw err;
      await delayImageRetry();
    }
  }
  return null; // unreachable — loop always returns or throws
};

// Embedded backup images are uploaded before the board's one Yjs update,
// keeping the update small. Do not replace live state if any image fails.
export const sanitizeImportedImages = (items, readImageBlob) => restoreBackupImages(items, {
  readImage: readBackupImage,
  readImageBlob,
  prepareImage: prepareImageBlob,
  uploadImage: uploadWithRetry,
  resolveSource: safeRuntimeImageSource,
});
