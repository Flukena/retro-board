import { IMAGE_MAX_BYTES, IMAGE_OUTPUT_MAX_DIMENSION, imageInfoIsWithinLimits, inspectRasterImageBlob, isSafeImageMime, normalizeRuntimeImageSource } from './security-boundaries.js';
import { getActiveRoomSession, roomFetch } from './room-session.js';
import { restoreBackupImages } from './backup-images.js';

const BYTES_PER_MIB = 1_048_576;
export const IMAGE_MAX_MIB_LABEL = (IMAGE_MAX_BYTES / BYTES_PER_MIB).toFixed(0);

const IMAGE_RETRY_ATTEMPTS = 6;
const IMAGE_RETRY_DELAY_MS = 1100;
const RATE_LIMIT_STATUS = 429;
const IMAGE_ENCODER_QUALITY = 0.85;
const JPEG_FALLBACK_QUALITY = 0.8;
const MIN_IMAGE_DIMENSION_PX = 1;
const MIN_IMAGE_BYTES = 1;
const MIME_PNG = 'image/png';
const MIME_JPEG = 'image/jpeg';
const MIME_GIF = 'image/gif';
const CANVAS_CONTEXT = '2d';
const DEFAULT_RELAY_PORT = '1234';
const ROOM_IMAGE_ROUTE = /^\/(?:yjs\/)?rooms\/[A-Za-z0-9_-]{32}\/(images\/[^/]+)$/;
const UPLOAD_RATE_LIMIT_ERROR = /: 429$/;
const delayImageRetry = () => new Promise((resolve) => { setTimeout(resolve, IMAGE_RETRY_DELAY_MS); });

const decodedDimensionsMatch = (width, height, info) => (
  Number.isSafeInteger(width) && Number.isSafeInteger(height)
  && width >= MIN_IMAGE_DIMENSION_PX && height >= MIN_IMAGE_DIMENSION_PX
  && ((width === info.width && height === info.height) || (width === info.height && height === info.width))
);
const encodedImageIsValid = (blob, inputMime) => (
  !!blob && (blob.type === MIME_JPEG || blob.type === inputMime)
  && blob.size >= MIN_IMAGE_BYTES && blob.size <= IMAGE_MAX_BYTES
);

const encodeImageCanvas = async (canvas, mime) => {
  let blob = await canvasToBlob(canvas, mime, mime === MIME_PNG ? undefined : IMAGE_ENCODER_QUALITY);
  if (!blob || !isSafeImageMime(blob.type) || blob.size > IMAGE_MAX_BYTES) {
    // Preserve the bounded JPEG fallback, including its loss of transparency.
    blob = await canvasToBlob(canvas, MIME_JPEG, JPEG_FALLBACK_QUALITY);
  }
  return encodedImageIsValid(blob, mime) ? blob : null;
};

const runtimeRelayBaseUrl = () => {
  if (typeof window === 'undefined') return null;
  return window.location.protocol === 'https:'
    ? `${window.location.origin}/yjs/`
    : `http://${window.location.hostname}:${import.meta.env.VITE_YJS_PORT || DEFAULT_RELAY_PORT}/`;
};

export const safeRuntimeImageSource = (value) => {
  if (typeof window === 'undefined') return null;
  return normalizeRuntimeImageSource(value, {
    pageOrigin: window.location.origin,
    relayBaseUrl: runtimeRelayBaseUrl(),
    roomHandle: getActiveRoomSession()?.roomHandle,
  });
};

export const canvasToBlob = (canvas, type, quality) => (
  new Promise((resolve) => canvas.toBlob(resolve, type, quality))
);

// Inspect headers before decode so malformed/decompression-bomb inputs are
// rejected early. PNG/JPEG/WebP are always redrawn through a bounded canvas,
// which strips EXIF and other metadata. GIFs retain animation only after a
// full structural/frame-budget check in inspectRasterImageBlob.
export const prepareImageBlob = async (blob) => {
  const info = await inspectRasterImageBlob(blob);
  if (!imageInfoIsWithinLimits(info)) return null;
  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = objectUrl;
    });
    let nw = img.naturalWidth;
    let nh = img.naturalHeight;
    // Browser JPEG orientation may swap the header dimensions.
    if (!decodedDimensionsMatch(nw, nh, info)) return null;

    if (info.mime === MIME_GIF) return { blob, nw, nh };

    const maxEdge = Math.max(nw, nh);
    const scale = Math.min(1, IMAGE_OUTPUT_MAX_DIMENSION / maxEdge);
    const cw = Math.max(MIN_IMAGE_DIMENSION_PX, Math.round(nw * scale));
    const ch = Math.max(MIN_IMAGE_DIMENSION_PX, Math.round(nh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext(CANVAS_CONTEXT);
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cw, ch);

    const finalBlob = await encodeImageCanvas(canvas, info.mime);
    nw = cw;
    nh = ch;
    if (!finalBlob) return null;
    return { blob: finalBlob, nw, nh };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

// Read only validated image routes. Room reads refresh the authenticated
// session through the same transport as uploads.
export const readBackupImage = async (source) => {
  const src = safeRuntimeImageSource(source);
  if (!src) throw new Error('image belongs to another room or server');
  const path = new URL(src).pathname;
  const roomImage = path.match(ROOM_IMAGE_ROUTE);
  for (let attempt = 0; attempt < IMAGE_RETRY_ATTEMPTS; attempt += 1) {
    const response = roomImage
      ? await roomFetch(roomImage[1])
      : await fetch(src, { credentials: 'include', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (response.ok) return response.blob();
    const status = response.status;
    await response.body?.cancel();
    if (status !== RATE_LIMIT_STATUS || attempt === IMAGE_RETRY_ATTEMPTS - 1) throw new Error(`image read failed: ${status}`);
    await delayImageRetry();
  }
};

// Server 429s ("image upload failed: 429") when the per-IP upload bucket is
// exhausted — re-uploading many legacy images back to back can hit this.
// Any other failure (bad format, network) won't fix itself on retry.
export const uploadWithRetry = async (blob, attempts = IMAGE_RETRY_ATTEMPTS) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await window.storage.uploadImage(blob);
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

