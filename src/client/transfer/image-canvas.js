import { IMAGE_MAX_BYTES, IMAGE_OUTPUT_MAX_DIMENSION, isSafeImageMime } from '../../domain/security-boundaries.js';

const IMAGE_ENCODER_QUALITY = 0.85;
const JPEG_FALLBACK_QUALITY = 0.8;
const MIN_IMAGE_DIMENSION_PX = 1;
const MIN_IMAGE_BYTES = 1;
const MIME_PNG = 'image/png';
const MIME_JPEG = 'image/jpeg';
const CANVAS_CONTEXT = '2d';
const DECODE_ERROR_MESSAGE = 'image could not be decoded';

export const canvasToBlob = (canvas, type, quality) => (
  new Promise((resolve) => canvas.toBlob(resolve, type, quality))
);

const encodedImageIsValid = (blob, inputMime) => (
  !!blob && (blob.type === MIME_JPEG || blob.type === inputMime)
  && blob.size >= MIN_IMAGE_BYTES && blob.size <= IMAGE_MAX_BYTES
);

export const encodeImageCanvas = async (canvas, mime) => {
  let blob = await canvasToBlob(canvas, mime, mime === MIME_PNG ? undefined : IMAGE_ENCODER_QUALITY);
  if (!blob || !isSafeImageMime(blob.type) || blob.size > IMAGE_MAX_BYTES) {
    // Preserve the bounded JPEG fallback, including its loss of transparency.
    blob = await canvasToBlob(canvas, MIME_JPEG, JPEG_FALLBACK_QUALITY);
  }
  return encodedImageIsValid(blob, mime) ? blob : null;
};

const loadImageElement = (img, objectUrl) => new Promise((resolve, reject) => {
  img.onload = resolve;
  img.onerror = (event) => reject(event instanceof Error ? event : new Error(DECODE_ERROR_MESSAGE));
  img.src = objectUrl;
});

/** Decode `blob` in the browser and hand the loaded image to `useImage`; the object URL is always revoked. */
export const withDecodedImage = async (blob, useImage) => {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await loadImageElement(img, objectUrl);
    return await useImage(img);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

/** Draw the image's first frame onto a canvas whose long edge is at most IMAGE_OUTPUT_MAX_DIMENSION. */
export const drawBoundedCanvas = (img, nw, nh) => {
  const scale = Math.min(1, IMAGE_OUTPUT_MAX_DIMENSION / Math.max(nw, nh));
  const width = Math.max(MIN_IMAGE_DIMENSION_PX, Math.round(nw * scale));
  const height = Math.max(MIN_IMAGE_DIMENSION_PX, Math.round(nh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext(CANVAS_CONTEXT);
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  return { canvas, width, height };
};

// Browser JPEG orientation may swap the header dimensions.
export const decodedDimensionsMatch = (width, height, info) => (
  Number.isSafeInteger(width) && Number.isSafeInteger(height)
  && width >= MIN_IMAGE_DIMENSION_PX && height >= MIN_IMAGE_DIMENSION_PX
  && ((width === info.width && height === info.height) || (width === info.height && height === info.width))
);

const stillMimeFor = (mime) => (mime === MIME_JPEG ? MIME_JPEG : MIME_PNG);

/**
 * Re-encode the first frame of a legacy image as a still: JPEG stays JPEG,
 * PNG/WebP/GIF become PNG. Returns null when the browser cannot draw it or the
 * decoded size differs from the inspected header `info`.
 */
export const flattenToStillImage = (blob, info) => withDecodedImage(blob, async (img) => {
  if (!decodedDimensionsMatch(img.naturalWidth, img.naturalHeight, info)) return null;
  const drawn = drawBoundedCanvas(img, img.naturalWidth, img.naturalHeight);
  return drawn ? encodeImageCanvas(drawn.canvas, stillMimeFor(blob.type)) : null;
});
