import {
  classifyImportedImageSource,
  imageInfoIsWithinLimits,
  inspectRasterImageBlob,
} from '../../domain/security-boundaries.js';

export const checkedImageBlob = async (src, readImage) => {
  const blob = await readImage(src);
  if (!imageInfoIsWithinLimits(await inspectRasterImageBlob(blob))) {
    throw new Error('invalid or oversized image');
  }
  return blob;
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
export async function embedBackupImages(items, readImage, maxGrowthBytes = Infinity) {
  const sources = new Map();
  const result = [];
  let growthBytes = 0;
  for (const item of items) {
    if (item.type !== 'image') { result.push(item); continue; }
    try {
      const source = classifyImportedImageSource(item.src);
      if (!source) throw new Error('invalid image source');
      if (!sources.has(item.src)) {
        sources.set(item.src, source.kind === 'data'
          ? item.src
          : await blobToDataUrl(await checkedImageBlob(item.src, readImage)));
      }
      const src = sources.get(item.src);
      growthBytes += JSON.stringify(src).length - JSON.stringify(item.src).length;
      if (growthBytes > maxGrowthBytes) throw new Error('backup exceeds the import file size limit; embedded image data is too large');
      result.push({ ...item, src });
    } catch (err) {
      throw new Error(`image ${item.id}: ${err.message}`);
    }
  }
  return result;
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
        } else if (source.kind === 'server') {
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
