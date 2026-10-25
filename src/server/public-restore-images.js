import { realpath, readdir, lstat, link } from 'node:fs/promises';
import { join } from 'node:path';
import { publicRelayEnvironment } from './public-wall-config.js';
import { ROOM_HANDLE_RE } from './relay-config.js';
import { isStoredImageFilename } from './relay-uploads.js';
import { canonicalPublicImageSource } from '../domain/public-wall-image-source.js';
import { PUBLIC_RELAY_PREFIX } from '../domain/public-wall-contract.js';

const RESTORE_IMAGE_ORIGIN = 'public-restore-images';

function imageReferences(doc) {
  const references = new Map();
  doc.getMap('items').forEach(item => {
    if (typeof item?.get !== 'function' || item.get('type') !== 'image') return;
    const source = canonicalPublicImageSource(item.get('src'));
    if (!source) throw new Error('Restore requires a valid public image source');
    const imageId = source.split('/').at(-1);
    if (!references.has(imageId)) references.set(imageId, []);
    references.get(imageId).push(item);
  });
  return references;
}

async function isolatedUploadsDirectory(databaseDirectory, uploadsDirectory) {
  const actualUploads = await realpath(uploadsDirectory);
  return publicRelayEnvironment({ YJS_PUBLIC_WALL: 'true', YJS_DB_DIR: databaseDirectory,
    YJS_UPLOADS_DIR: actualUploads }).YJS_UPLOADS_DIR;
}

async function publicImageIndex(directory, wanted) {
  const files = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !isStoredImageFilename(entry.name)) continue;
    const separator = entry.name.indexOf('.');
    const imageId = entry.name.slice(separator + 1);
    if (!ROOM_HANDLE_RE.test(entry.name.slice(0, separator)) || !wanted.has(imageId)) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (!info.isFile()) continue;
    const previous = files.get(imageId);
    if (previous && (previous.device !== info.dev || previous.inode !== info.ino)) {
      throw new Error('Restore public image file is ambiguous');
    }
    files.set(imageId, { path, device: info.dev, inode: info.ino });
  }
  return files;
}

async function restoreFilePlan(directory, references) {
  const files = await publicImageIndex(directory, references);
  return Array.from(references.keys(), imageId => {
    const source = files.get(imageId);
    if (!source) throw new Error('Restore public image file is missing');
    return { imageId, source: source.path };
  });
}

class PreparedPublicImages {
  #doc;
  #directory;
  #references;
  #plan;

  constructor(doc, directory, references, plan) {
    this.#doc = doc;
    this.#directory = directory;
    this.#references = references;
    this.#plan = plan;
  }

  async restore(roomHandle) {
    if (!ROOM_HANDLE_RE.test(roomHandle || '')) throw new Error('Restore requires a valid public room handle');
    if (!this.#plan.length) return false;
    for (const { imageId, source } of this.#plan) await link(source, join(this.#directory, `${roomHandle}.${imageId}`));
    this.#doc.transact(() => {
      for (const { imageId } of this.#plan) {
        const source = `${PUBLIC_RELAY_PREFIX}/rooms/${roomHandle}/images/${imageId}`;
        for (const item of this.#references.get(imageId)) item.set('src', source);
      }
    }, RESTORE_IMAGE_ORIGIN);
    return true;
  }
}

export async function preparePublicRestoreImages(doc, { databaseDirectory, uploadsDirectory }) {
  const references = imageReferences(doc);
  if (!references.size) return new PreparedPublicImages(doc, null, references, []);
  const directory = await isolatedUploadsDirectory(databaseDirectory, uploadsDirectory);
  return new PreparedPublicImages(doc, directory, references, await restoreFilePlan(directory, references));
}

export async function restorePublicImages(doc, options) {
  return (await preparePublicRestoreImages(doc, options)).restore(options.roomHandle);
}
