import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js/index-native.js';
import { assertArchiveSize, createBoardArchiveArtifact, readBoardArchive } from './board-archive.js';
import { restoreBackupImages } from './backup-images.js';
import { IMPORT_MAX_ARCHIVE_FILE_BYTES, importBundleByteLength } from './import-schema.js';

const gif = new Blob([Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')], { type: 'image/gif' });
const imageSrc = `/rooms/${'a'.repeat(32)}/images/12345678-abcd.gif`;
const destinationSrc = `/rooms/${'b'.repeat(32)}/images/87654321-abcd.gif`;
const board = { items: [
  { id: 'zone-1', type: 'zone', x: 0, y: 0, w: 800, h: 500, title: 'Images' },
  { id: 'image-1', type: 'image', x: 10, y: 20, w: 120, h: 120, parentZoneId: 'zone-1', src: imageSrc, natW: 1, natH: 1 },
  { id: 'image-2', type: 'image', x: 150, y: 20, w: 120, h: 120, parentZoneId: 'zone-1', src: imageSrc, natW: 1, natH: 1 },
] };

test('binary ZIP exports one copy per image source and imports every object into another room', async () => {
  let reads = 0;
  const artifact = await createBoardArchiveArtifact({ board }, async () => { reads++; return gif; });
  assert.equal(reads, 1);
  assert.match(artifact.fileName, /\.zip$/);
  assert.equal(board.items[1].src, imageSrc);
  const zip = new ZipReader(new BlobReader(artifact.blob), { useWebWorkers: false });
  const entries = await zip.getEntries();
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.compressionMethod === 0));
  await zip.close();
  const manifest = await readBoardArchive(artifact.blob);
  assert.equal(manifest.items.length, 3);
  let uploads = 0;
  const restored = await restoreBackupImages(manifest.items, {
    readImageBlob: manifest.readImageBlob,
    readImage: () => assert.fail('must not request the old room'),
    prepareImage: async blob => {
      assert.deepEqual(await blob.arrayBuffer(), await gif.arrayBuffer());
      return { blob, nw: 1, nh: 1 };
    },
    uploadImage: async () => { uploads++; return destinationSrc; },
    resolveSource: src => src === destinationSrc ? src : null,
  });
  assert.equal(uploads, 1);
  assert.deepEqual(restored.slice(1), board.items.slice(1).map(item => ({
    ...manifest.items.find(other => other.id === item.id), src: destinationSrc,
  })));
  assert.ok(importBundleByteLength({ items: restored }) < 2000);
});

test('archive file budget accepts exactly 1 GiB and rejects one byte over it before reading', async () => {
  assert.equal(IMPORT_MAX_ARCHIVE_FILE_BYTES, 1024 ** 3);
  assert.doesNotThrow(() => assertArchiveSize(1024 ** 3));
  assert.throws(() => assertArchiveSize(1024 ** 3 + 1), /1 GB/);
  await assert.rejects(readBoardArchive({ size: 1024 ** 3 + 1 }), /1 GB/);
});

const malformedArchive = async (extraEntries, mutate = payload => payload) => {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level: 0 });
  const payload = mutate({ version: 2, format: 'retro-board-archive', board: {
    items: board.items.map(item => item.type === 'image' ? { ...item, src: 'images/00000000.gif' } : item),
  } });
  await writer.add('board.json', new TextReader(JSON.stringify(payload)));
  for (const [name, blob] of extraEntries) await writer.add(name, new BlobReader(blob));
  return writer.close();
};

test('rejects missing images, unexpected files and unreferenced assets before board replacement', async () => {
  await assert.rejects(readBoardArchive(await malformedArchive([])), /missing archive image/);
  await assert.rejects(readBoardArchive(await malformedArchive([['../image.gif', gif]])), /invalid archive entry|Unsafe filename/);
  await assert.rejects(readBoardArchive(await malformedArchive([
    ['images/00000000.gif', gif], ['images/00000001.gif', gif],
  ])), /unreferenced images/);
  await assert.rejects(readBoardArchive(await malformedArchive([['images/00000000.gif', gif]], payload => ({
    ...payload, board: { items: payload.board.items.map(item => ({ ...item, id: 'duplicate' })) },
  }))), /duplicate item id/);
});

test('corrupted image checksums abort the import', async () => {
  const artifact = await createBoardArchiveArtifact({ board }, async () => gif);
  const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
  const signature = new TextEncoder().encode('GIF89a');
  const index = Buffer.from(bytes).indexOf(signature);
  assert.ok(index > 0);
  bytes[index + 6] ^= 1;
  const manifest = await readBoardArchive(new Blob([bytes]));
  await assert.rejects(manifest.readImageBlob(manifest.items[1]), /signature|checksum|CRC32/i);
});

test('archive image reads stay bounded and never read the entire backup as text or bytes', async () => {
  const bytes = Buffer.alloc(1024 * 1024);
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64').copy(bytes);
  const png = new Blob([bytes], { type: 'image/png' });
  const artifact = await createBoardArchiveArtifact({ board }, async () => png);
  class LazyArchive extends Blob {
    text() { assert.fail('whole-file text read'); }
    arrayBuffer() { assert.fail('whole-file byte read'); }
  }
  const manifest = await readBoardArchive(new LazyArchive([artifact.blob]));
  assert.deepEqual(await (await manifest.readImageBlob(manifest.items[1])).arrayBuffer(), await png.arrayBuffer());
});
