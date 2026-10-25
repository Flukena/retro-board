import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalPublicImageSource } from '../domain/public-wall-image-source.js';
import { PUBLIC_RELAY_PREFIX } from '../domain/public-wall-contract.js';
import { IMAGE_MAX_BYTES } from '../domain/security-boundaries.js';

const PUBLIC_IMAGE_ROOM_PREFIX = `${PUBLIC_RELAY_PREFIX}/rooms/`;
const IMAGE_ROUTE_SEPARATOR = '/images/';

async function verifyImageFile(filename) {
  let entry;
  try { entry = await lstat(filename); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Backup is missing a referenced public image', { cause: error });
    throw error;
  }
  if (!entry.isFile() || entry.size <= 0 || entry.size > IMAGE_MAX_BYTES) {
    throw new Error('Backup contains an invalid public image file');
  }
}

export async function verifyPublicUploadFiles(doc, uploadsDirectory) {
  const filenames = new Set();
  doc.getMap('items').forEach(item => {
    if (typeof item?.get !== 'function' || item.get('type') !== 'image') return;
    const source = canonicalPublicImageSource(item.get('src'));
    if (source) filenames.add(source.slice(PUBLIC_IMAGE_ROOM_PREFIX.length).replace(IMAGE_ROUTE_SEPARATOR, '.'));
  });
  for (const filename of filenames) await verifyImageFile(join(uploadsDirectory, filename));
  return filenames.size;
}
