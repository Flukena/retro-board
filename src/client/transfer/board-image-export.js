import { readBackupImage } from './image-upload.js';
import { boardImageBounds, boardImageScale, buildBoardImageScene, sceneImageUrls, EXPORT_PREFERRED_SCALE } from './board-image-scene.js';
import { paintScene } from '../public-wall/canvas-plates.js';
import { createImagePdf, PDF_MIME_TYPE } from './pdf-image-document.js';

export const PNG_MIME_TYPE = 'image/png';
const JPEG_MIME_TYPE = 'image/jpeg';
// High enough that sticky text stays crisp once the PDF is zoomed in.
const PDF_JPEG_QUALITY = 0.92;
const IMAGE_FETCH_CONCURRENCY = 3;
const DATA_URL_PREFIX = 'data:';

const cssToken = (style, name) => style.getPropertyValue(name).trim();

/** Theme values the scene needs, read from the live CSS-variable tokens. */
function readBoardImageLook(documentRef) {
  const style = documentRef.defaultView.getComputedStyle(documentRef.documentElement);
  return { background: cssToken(style, '--bg'), text: cssToken(style, '--text'),
    uiFont: cssToken(style, '--font-ui'), displayFont: cssToken(style, '--font-display') };
}

async function decodeImage(documentRef, url) {
  const image = new documentRef.defaultView.Image();
  image.src = url;
  await image.decode();
  return image;
}

// Room images are fetched with the room session, then drawn from a blob URL,
// so the canvas stays readable even when the relay is another origin (dev).
async function loadSceneImage(documentRef, source, readImage) {
  if (source.startsWith(DATA_URL_PREFIX)) return decodeImage(documentRef, source);
  const objectUrl = URL.createObjectURL(await readImage(source));
  try {
    return await decodeImage(documentRef, objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Decode every image the scene uses; an image that fails is left out and counted. */
export async function loadSceneImages(documentRef, urls, readImage = readBackupImage) {
  const images = new Map();
  let failed = 0;
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      try {
        images.set(url, await loadSceneImage(documentRef, url, readImage));
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, urls.length) }, worker));
  return { images, failed };
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('board image canvas produced no image'))), type, quality);
  });
}

async function renderBoardCanvas(documentRef, board, labels) {
  const bounds = boardImageBounds(board.items);
  if (!bounds) return null;
  const scale = boardImageScale(bounds);
  await documentRef.fonts?.ready;
  const scene = buildBoardImageScene({ ...board, look: readBoardImageLook(documentRef), labels, bounds, scale });
  const { images, failed } = await loadSceneImages(documentRef, sceneImageUrls(scene));
  const canvas = documentRef.createElement('canvas');
  canvas.width = scene.width;
  canvas.height = scene.height;
  paintScene(canvas.getContext('2d'), scene, images);
  return { canvas, width: scene.width, height: scene.height, reduced: scale < EXPORT_PREFERRED_SCALE, failedImages: failed };
}

const releaseCanvas = (canvas) => { canvas.width = 0; canvas.height = 0; };

/**
 * Render the board to PNG or single-page PDF bytes. `board` is
 * `{items, votesByItem, userId, allRevealed}`; returns null for an empty board.
 */
export async function renderBoardImage(documentRef, board, labels, format) {
  const rendered = await renderBoardCanvas(documentRef, board, labels);
  if (!rendered) return null;
  const { canvas, width, height, ...notes } = rendered;
  try {
    if (format === PNG_MIME_TYPE) return { blob: await canvasBlob(canvas, PNG_MIME_TYPE), ...notes };
    const jpeg = new Uint8Array(await (await canvasBlob(canvas, JPEG_MIME_TYPE, PDF_JPEG_QUALITY)).arrayBuffer());
    return { blob: new Blob([createImagePdf(jpeg, width, height)], { type: PDF_MIME_TYPE }), ...notes };
  } finally {
    releaseCanvas(canvas);
  }
}
