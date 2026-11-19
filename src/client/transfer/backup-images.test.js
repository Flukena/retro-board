import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedImageOrStill, createStillFallbackReader, embedBackupImages, restoreBackupImages } from './backup-images.js';
import { apngBlob, stillPngBlob, STILL_PNG_BYTES } from '../../test-support/apng-fixture.js';
import { GIF_MAX_DIMENSION, IMAGE_MAX_BYTES, IMAGE_SOURCE_MAX_DIMENSION, imageInfoIsWithinLimits, inspectRasterImageBlob } from '../../domain/security-boundaries.js';
import { createPortableJsonBackupArtifact } from './board-backup.js';
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_CSV_FILE_BYTES,
  normalizeImportManifest,
  importBundleByteLength,
} from '../../domain/import-schema.js';

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
  await assert.rejects(embedBackupImages([image], async () => new Blob(['bad'], { type: 'image/gif' }), Infinity, async () => null), /invalid or oversized image/);
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
  const { items } = await embedBackupImages([image, { ...image, id: 'image-2', src: '/images/abcdef12-abcd.gif' }], async () => gif);
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

const apngSrc = '/images/12345678-abcd.png';
const apngItem = (id, src = apngSrc) => ({ ...image, id, src, parentZoneId: null });
const oversizedPng = () => new Blob([Buffer.alloc(IMAGE_MAX_BYTES + 1)], { type: 'image/png' });
// Stands in for the browser canvas: always yields a valid still PNG.
const pngWithHeader = (width, height) => {
  const bytes = Buffer.from(STILL_PNG_BYTES);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Blob([bytes], { type: 'image/png' });
};
// A 1x1 GIF whose screen and frame are widened past GIF_MAX_DIMENSION.
const bigGifBlob = () => {
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  bytes.writeUInt16LE(GIF_MAX_DIMENSION + 1, 6);
  bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(GIF_MAX_DIMENSION + 1, bytes.indexOf(0x2c) + 5);
  return new Blob([bytes], { type: 'image/gif' });
};
const stillFlatten = async () => stillPngBlob();

test('the APNG fixture is really rejected by the import limits', async () => {
  const info = await inspectRasterImageBlob(apngBlob());
  assert.equal(info.animated, true);
  assert.equal(imageInfoIsWithinLimits(info), false);
  assert.equal(imageInfoIsWithinLimits(await inspectRasterImageBlob(stillPngBlob())), true);
});

test('a passing image is returned byte-identical and never converted', async () => {
  const still = stillPngBlob();
  const result = await checkedImageOrStill(still, async () => assert.fail('must not re-encode a passing image'));
  assert.equal(result.blob, still);
  assert.equal(result.flattened, false);
});

test('an animated PNG or a GIF over its own limits is converted to a still that passes the limits', async () => {
  for (const legacy of [apngBlob(), bigGifBlob()]) {
    const result = await checkedImageOrStill(legacy, stillFlatten);
    assert.equal(result.flattened, true);
    assert.notEqual(result.blob, legacy);
    assert.equal(imageInfoIsWithinLimits(await inspectRasterImageBlob(result.blob)), true);
  }
});

test('a header beyond the decode bounds or an unparsed header aborts without decoding', async () => {
  const neverDecode = async () => assert.fail('must not decode');
  const bad = [
    pngWithHeader(60000, 60000),
    pngWithHeader(IMAGE_SOURCE_MAX_DIMENSION + 1, 10),
    pngWithHeader(8000, 8000),
    oversizedPng(),
    new Blob([Buffer.from('not a png')], { type: 'image/png' }),
  ];
  for (const blob of bad) await assert.rejects(checkedImageOrStill(blob, neverDecode), /invalid or oversized image/);
});

test('the flatten step receives the inspected header so the decoded size can be checked', async () => {
  let seen;
  await checkedImageOrStill(apngBlob(), async (blob, info) => { seen = info; return stillPngBlob(); });
  assert.deepEqual([seen.width, seen.height, seen.animated], [1, 1, true]);
});

test('an unsafe MIME, an undecodable blob, or a conversion that still fails the limits aborts', async () => {
  const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' });
  await assert.rejects(checkedImageOrStill(svg, async () => assert.fail('unsafe MIME is never decoded')), /invalid or oversized image/);
  await assert.rejects(checkedImageOrStill(apngBlob(), async () => null), /invalid or oversized image/);
  await assert.rejects(checkedImageOrStill(apngBlob(), async () => apngBlob()), /invalid or oversized image/);
  await assert.rejects(checkedImageOrStill(apngBlob(), async () => { throw new Error('decode failed'); }), /decode failed/);
});

test('duplicate sources convert once and every item id that uses them is reported', async () => {
  let reads = 0;
  let conversions = 0;
  const reader = createStillFallbackReader(async () => { reads += 1; return apngBlob(); }, async () => { conversions += 1; return stillPngBlob(); });
  const first = await reader.read(apngItem('a'));
  const second = await reader.read(apngItem('b'));
  assert.equal(first, second);
  assert.deepEqual([reads, conversions], [1, 1]);
  assert.deepEqual(reader.flattenedIds, ['a', 'b']);
});

test('JSON export of a board holding an APNG produces an artifact, reports the id, and re-imports', async () => {
  const items = [apngItem('legacy-1'), apngItem('legacy-2'), { ...image, id: 'fine', parentZoneId: null, src: '/images/abcdef12-abcd.gif' }];
  const readImage = async (src) => (src === apngSrc ? apngBlob() : gif);
  const artifact = await createPortableJsonBackupArtifact({ board: { items } }, readImage, stillFlatten);
  assert.deepEqual(artifact.flattenedImageIds, ['legacy-1', 'legacy-2']);
  const manifest = normalizeImportManifest(JSON.parse(artifact.contents));
  const embedded = manifest.items.filter(item => item.type === 'image');
  assert.equal(embedded.length, 3);
  assert.match(embedded[0].src, /^data:image\/png;base64,/);
  const bytes = Buffer.from(embedded[0].src.split(',')[1], 'base64');
  const info = await inspectRasterImageBlob(new Blob([bytes], { type: 'image/png' }));
  assert.equal(imageInfoIsWithinLimits(info), true);
  assert.match(embedded[2].src, /^data:image\/gif;base64,R0lGODlh/);
});
