import test from 'node:test';
import assert from 'node:assert/strict';
import { embedBackupImages, restoreBackupImages } from './backup-images.js';
import { createPortableJsonBackupArtifact } from './board-backup.js';
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_CSV_FILE_BYTES,
  normalizeImportManifest,
  importBundleByteLength,
} from './import-schema.js';

const gif = new Blob([Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')], { type: 'image/gif' });
const originalSrc = `/rooms/${'a'.repeat(32)}/images/12345678-abcd.gif`;
const restoredSrc = `/rooms/${'b'.repeat(32)}/images/87654321-abcd.gif`;
const image = { id: 'image-1', type: 'image', x: 15, y: 20, w: 120, h: 120, src: originalSrc, parentZoneId: 'zone-1', natW: 1, natH: 1 };

test('portable backups exceeding the old 25 MiB limit export and normalize without losing images', async () => {
  const pngBytes = Buffer.alloc(1024 * 1024);
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64').copy(pngBytes);
  const png = new Blob([pngBytes], { type: 'image/png' });
  const items = Array.from({ length: 20 }, (_, index) => ({
    ...image, id: `image-${index}`, parentZoneId: null, src: '/images/12345678-abcd.png',
  }));
  const artifact = await createPortableJsonBackupArtifact({ board: { items } }, async () => png);
  const fileBytes = Buffer.byteLength(artifact.contents);
  assert.ok(fileBytes > 25 * 1024 * 1024);
  assert.ok(fileBytes < IMPORT_MAX_FILE_BYTES);
  assert.equal(IMPORT_MAX_CSV_FILE_BYTES, 25 * 1024 * 1024);
  const manifest = normalizeImportManifest(JSON.parse(artifact.contents));
  assert.equal(manifest.items.length, items.length);
  assert.ok(manifest.items.every(item => item.src.startsWith('data:image/png;base64,')));
  const restored = await restoreBackupImages(manifest.items, {
    prepareImage: async blob => ({ blob, nw: 1, nh: 1 }),
    uploadImage: async () => restoredSrc,
    resolveSource: src => src === restoredSrc ? src : null,
  });
  assert.equal(restored.length, items.length);
  assert.ok(importBundleByteLength({ items: restored }) < 10_000);
});

test('portable JSON restores every image into another room with geometry and nesting intact', async () => {
  const board = { items: [
    { id: 'zone-1', type: 'zone', x: 0, y: 0, w: 400, h: 400, title: 'Images' },
    image,
    { ...image, id: 'image-2', x: 150, rotation: 45, zIndex: 20 },
  ] };
  let reads = 0;
  const artifact = await createPortableJsonBackupArtifact({ board }, async (src) => {
    assert.equal(src, originalSrc);
    reads += 1;
    return gif;
  });
  assert.equal(reads, 1);
  assert.equal(board.items[1].src, originalSrc);
  assert.doesNotMatch(artifact.contents, /rooms\//);
  const manifest = normalizeImportManifest(JSON.parse(artifact.contents));
  let uploads = 0;
  const restored = await restoreBackupImages(manifest.items, {
    readImage: () => assert.fail('portable import must not read the source room'),
    prepareImage: async (blob) => {
      assert.deepEqual(await blob.arrayBuffer(), await gif.arrayBuffer());
      return { blob, nw: 1, nh: 1 };
    },
    uploadImage: async () => { uploads += 1; return restoredSrc; },
    resolveSource: (src) => src === restoredSrc ? src : null,
  });
  assert.equal(uploads, 1);
  assert.equal(restored.length, board.items.length);
  restored.slice(1).forEach((item, index) => {
    assert.deepEqual(item, { ...manifest.items[index + 1], src: restoredSrc });
  });
  assert.ok(importBundleByteLength({ items: restored }) < 2000);
});

test('failed exports do not produce an incomplete artifact', async () => {
  await assert.rejects(createPortableJsonBackupArtifact({ board: { items: [{ ...image, parentZoneId: null }] } }, async () => {
    throw new Error('image read failed: 404');
  }), /image image-1: image read failed: 404/);
  await assert.rejects(embedBackupImages([image], async () => new Blob(['bad'], { type: 'image/gif' })), /invalid or oversized image/);
  await assert.rejects(embedBackupImages([image, { ...image, id: 'image-2' }], async () => gif, 0), /size limit/);
});

test('legacy URLs remain usable in their room and cannot silently disappear across rooms', async () => {
  const restored = await restoreBackupImages([image], {
    resolveSource: (src) => src,
    readImage: async () => gif,
  });
  assert.deepEqual(restored, [image]);
  await assert.rejects(restoreBackupImages([image], { resolveSource: () => null }), /another room or server/);
  await assert.rejects(restoreBackupImages([image], {
    resolveSource: (src) => src,
    readImage: async () => { throw new Error('image read failed: 404'); },
  }), /image read failed: 404/);
});

test('a failed embedded image aborts import instead of returning a partial board', async () => {
  const items = await embedBackupImages([image, { ...image, id: 'image-2', src: '/images/abcdef12-abcd.gif' }], async () => gif);
  items[1].src = 'data:image/gif;base64,R0lG';
  let uploads = 0;
  const options = {
    resolveSource: (src) => src,
    prepareImage: async (blob) => blob.size === gif.size ? { blob, nw: 1, nh: 1 } : null,
    uploadImage: async () => { uploads += 1; return restoredSrc; },
  };
  await assert.rejects(restoreBackupImages(items, options), /image image-2: image could not be processed/);
  assert.equal(uploads, 1);
  options.prepareImage = async () => ({ blob: gif, nw: 1, nh: 1 });
  options.uploadImage = async () => { throw new Error('image upload failed: 429'); };
  await assert.rejects(restoreBackupImages(items, options), /image upload failed: 429/);
});
