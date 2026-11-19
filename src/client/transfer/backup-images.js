import {
  classifyImportedImageSource,
  imageInfoIsWithinLimits,
  inspectRasterImageBlob,
  isDecodeSafeLegacyImage,
} from '../../domain/security-boundaries.js';
import { flattenToStillImage } from './image-canvas.js';

const INVALID_IMAGE_MESSAGE = 'invalid or oversized image';

export const checkedImageBlob = async (src, readImage) => {
  const blob = await readImage(src);
  if (!imageInfoIsWithinLimits(await inspectRasterImageBlob(blob))) {
    throw new Error(INVALID_IMAGE_MESSAGE);
  }
  return blob;
};

// Owner exception to the export round trip (CONTEXT.md, Backup manifest): a
// legacy image that fails today's rules is exported as a still of its first frame.
export const checkedImageOrStill = async (blob, flattenToStill) => {
  const info = await inspectRasterImageBlob(blob);
  if (imageInfoIsWithinLimits(info)) return { blob, flattened: false };
  if (!isDecodeSafeLegacyImage(info)) throw new Error(INVALID_IMAGE_MESSAGE);
  const still = await flattenToStill(blob, info);
  if (!still || !imageInfoIsWithinLimits(await inspectRasterImageBlob(still))) throw new Error(INVALID_IMAGE_MESSAGE);
  return { blob: still, flattened: true };
};

// One reader per export: each source is read and converted once, while every
// item that uses a converted source is listed in `flattenedIds`.
export const createStillFallbackReader = (readImage, flattenToStill = flattenToStillImage) => {
  const checked = new Map();
  const flattenedIds = [];
  const read = async (item) => {
    if (!checked.has(item.src)) checked.set(item.src, await checkedImageOrStill(await readImage(item.src), flattenToStill));
    const entry = checked.get(item.src);
    if (entry.flattened) flattenedIds.push(item.id);
    return entry.blob;
  };
  return { read, flattenedIds };
};

const blobToDataUrl = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
};

// Share image bytes for duplicate sources while retaining every object's
// identity, geometry, and parent zone. Any failure aborts the whole operation.
export async function embedBackupImages(items, readImage, maxGrowthBytes = Infinity, flattenToStill = flattenToStillImage) {
  const dataUrls = new Map();
  const reader = createStillFallbackReader(readImage, flattenToStill);
  const result = [];
  let growthBytes = 0;
  for (const item of items) {
    if (item.type !== 'image') { result.push(item); continue; }
    try {
      const source = classifyImportedImageSource(item.src);
      if (!source) throw new Error('invalid image source');
      const blob = source.kind === 'data' ? null : await reader.read(item);
      if (blob && !dataUrls.has(blob)) dataUrls.set(blob, await blobToDataUrl(blob));
      const src = blob ? dataUrls.get(blob) : item.src;
      growthBytes += JSON.stringify(src).length - JSON.stringify(item.src).length;
      if (growthBytes > maxGrowthBytes) throw new Error('backup exceeds the import file size limit; embedded image data is too large');
      result.push({ ...item, src });
    } catch (err) {
      throw new Error(`image ${item.id}: ${err.message}`);
    }
  }
  return { items: result, flattenedIds: reader.flattenedIds };
}

export async function restoreBackupImages(items, { readImage, readImageBlob, prepareImage, uploadImage, resolveSource }) {
  const sources = new Map();
  const result = [];
  for (const item of items) {
    if (item.type !== 'image') { result.push(item); continue; }
    try {
      const source = classifyImportedImageSource(item.src);
      if (!source) throw new Error('invalid image source');
      if (!sources.has(item.src)) {
        if (readImageBlob) {
          const rawBlob = await readImageBlob(item);
          const prepared = await prepareImage(rawBlob);
          if (!prepared) throw new Error('image could not be processed');
          const src = await uploadImage(prepared.blob);
          if (!src || !resolveSource(src)) throw new Error('invalid uploaded image URL');
          sources.set(item.src, { src, natW: prepared.nw, natH: prepared.nh });
        } else if (source.kind === 'server' || source.kind === 'e2e') {
          const src = resolveSource(item.src);
          if (!src) throw new Error('image belongs to another room or server; export again from the original room');
          await checkedImageBlob(src, readImage);
          sources.set(item.src, { src });
        } else {
          const binary = atob(source.payload);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          const prepared = await prepareImage(new Blob([bytes], { type: source.mime }));
          if (!prepared) throw new Error('image could not be processed');
          const src = await uploadImage(prepared.blob);
          if (!src || !resolveSource(src)) throw new Error('invalid uploaded image URL');
          sources.set(item.src, { src, natW: prepared.nw, natH: prepared.nh });
        }
      }
      result.push({ ...item, ...sources.get(item.src) });
    } catch (err) {
      throw new Error(`image ${item.id}: ${err.message}`);
    }
  }
  return result;
}
