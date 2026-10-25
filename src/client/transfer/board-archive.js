import {
  BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter,
} from '@zip.js/zip.js/index-native.js';
import { createJsonBackupArtifact } from './board-backup.js';
import { checkedImageBlob } from './backup-images.js';
import {
  IMPORT_MAX_ARCHIVE_FILE_BYTES,
  IMPORT_MAX_ITEMS,
  normalizeImportManifest,
} from '../../domain/import-schema.js';
import { IMAGE_MAX_BYTES, classifyImportedImageSource } from '../../domain/security-boundaries.js';

const MANIFEST_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_PATH = /^images\/[a-f0-9]{8}\.(png|jpeg|webp|gif)$/;
const ZIP_OPTIONS = { useWebWorkers: false, level: 0, zip64: false };
const fail = message => { throw new Error(message); };

export function assertArchiveSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > IMPORT_MAX_ARCHIVE_FILE_BYTES) {
    fail('backup archive exceeds 1 GB');
  }
}

// Images are already compressed raster files. Store their binary bytes in ZIP
// without base64 or re-compression, and stream entries through Blob readers.
export async function createBoardArchiveArtifact(options, readImage) {
  const artifact = createJsonBackupArtifact(options);
  const writer = new ZipWriter(new BlobWriter('application/zip'), ZIP_OPTIONS);
  const assets = new Map();
  const items = [];
  let imageBytes = 0;
  for (const item of artifact.payload.board.items) {
    if (item.type !== 'image') { items.push(item); continue; }
    try {
      if (!assets.has(item.src)) {
        const source = classifyImportedImageSource(item.src);
        if (!source) fail('invalid image source');
        const blob = await checkedImageBlob(item.src, async src => {
          if (source.kind === 'server') return readImage(src);
          const binary = atob(source.payload);
          return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: source.mime });
        });
        const name = `images/${assets.size.toString(16).padStart(8, '0')}.${blob.type.split('/')[1]}`;
        imageBytes += blob.size;
        // Reserve a bounded manifest and enough space for ZIP entry headers.
        assertArchiveSize(imageBytes + 512 * (assets.size + 2));
        await writer.add(name, new BlobReader(blob));
        assets.set(item.src, name);
      }
      items.push({ ...item, src: assets.get(item.src) });
    } catch (err) {
      throw new Error(`image ${item.id}: ${err.message}`);
    }
  }
  const payload = {
    ...artifact.payload,
    version: 2,
    format: 'retro-board-archive',
    board: { ...artifact.payload.board, items },
  };
  const contents = JSON.stringify(payload, null, 2);
  const manifestBytes = new TextEncoder().encode(contents).byteLength;
  if (manifestBytes > MANIFEST_MAX_BYTES) fail('archive manifest is too large');
  assertArchiveSize(imageBytes + manifestBytes + 512 * (assets.size + 1));
  await writer.add('board.json', new TextReader(contents));
  const blob = await writer.close();
  assertArchiveSize(blob.size);
  return {
    fileName: artifact.fileName.replace(/\.json$/, '.zip'),
    mimeType: 'application/zip',
    blob,
    geometryRepairs: artifact.geometryRepairs,
  };
}

// Inspect the directory and small JSON manifest first. Each image is read and
// checksum-verified only when imported, so the 1 GB file is never parsed as
// one string or loaded into one ArrayBuffer.
export async function readBoardArchive(file, importedAt = Date.now()) {
  assertArchiveSize(file.size);
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false, checkSignature: true });
  try {
    const entries = new Map();
    let totalBytes = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.size >= IMPORT_MAX_ITEMS + 1) fail('too many archive entries');
      if (entries.has(entry.filename)) fail('duplicate archive entry');
      if (entry.directory || entry.encrypted || entry.compressionMethod !== 0) {
        fail('backup must contain unencrypted stored ZIP entries');
      }
      const maxBytes = entry.filename === 'board.json' ? MANIFEST_MAX_BYTES : IMAGE_MAX_BYTES;
      if (entry.filename !== 'board.json' && !IMAGE_PATH.test(entry.filename)) fail('invalid archive entry');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1
        || entry.uncompressedSize > maxBytes || entry.compressedSize !== entry.uncompressedSize) {
        fail('archive entry is too large or invalid');
      }
      totalBytes += entry.uncompressedSize;
      assertArchiveSize(totalBytes);
      entries.set(entry.filename, entry);
    }
    const manifestEntry = entries.get('board.json');
    if (!manifestEntry) fail('missing board.json');
    const payload = JSON.parse(await manifestEntry.getData(new TextWriter(), { checkSignature: true }));
    if (payload.version !== 2 || payload.format !== 'retro-board-archive' || !Array.isArray(payload.board?.items)) {
      fail('invalid backup archive manifest');
    }
    const assetById = new Map();
    const referenced = new Set(['board.json']);
    const items = payload.board.items.map(item => {
      if (item?.type !== 'image') return item;
      if (!IMAGE_PATH.test(item.src) || !entries.has(item.src)) fail(`image ${item.id}: missing archive image`);
      assetById.set(item.id, item.src);
      referenced.add(item.src);
      // Strict schema validation still applies; this surrogate is never
      // rendered or written to Yjs. Import uploads its corresponding Blob.
      return { ...item, src: `/${item.src}` };
    });
    if (referenced.size !== entries.size) fail('archive contains unreferenced images');
    const manifest = normalizeImportManifest({ ...payload, board: { ...payload.board, items } }, importedAt);
    return {
      ...manifest,
      readImageBlob: async item => {
        const name = assetById.get(item.id);
        const mime = `image/${name.match(IMAGE_PATH)[1]}`;
        return entries.get(name).getData(new BlobWriter(mime), { checkSignature: true, useWebWorkers: false });
      },
    };
  } finally {
    await reader.close();
  }
}
