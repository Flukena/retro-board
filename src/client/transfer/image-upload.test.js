import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortableJsonBackupArtifact } from './board-backup.js';
import { canvasToBlob, prepareImageBlob, uploadWithRetry, readBackupImage, sanitizeImportedImages } from './image-upload.js';

const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const imageBlob = (base64, type) => new Blob([Buffer.from(base64, 'base64')], { type });

function installGlobals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
}

function browserImage(width, height, fail = false) {
  return class {
    naturalWidth = width;
    naturalHeight = height;
    set src(value) {
      this.loadedSource = value;
      queueMicrotask(() => { if (fail) this.onerror(new Error('decode failed')); else this.onload(); });
    }
  };
}

test('canvas conversion forwards MIME/quality and preserves null encoder failure', async () => {
  const calls = [];
  const result = await canvasToBlob({ toBlob: (resolve, type, quality) => {
    calls.push({ type, quality }); resolve(null);
  } }, 'image/jpeg', 0.85);
  assert.equal(result, null);
  assert.deepEqual(calls, [{ type: 'image/jpeg', quality: 0.85 }]);
});

test('GIF prep retains validated animation and revokes object URLs even on decode failure', async (t) => {
  const revoked = [];
  const revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
  t.after(() => { URL.revokeObjectURL = revoke; });
  installGlobals(t, { Image: browserImage(1, 1) });
  const blob = imageBlob(GIF_BASE64, 'image/gif');
  assert.deepEqual(await prepareImageBlob(blob), { blob, nw: 1, nh: 1 });
  assert.equal(revoked.length, 1);
  globalThis.Image = browserImage(1, 1, true);
  await assert.rejects(prepareImageBlob(blob), /decode failed/);
  assert.equal(revoked.length, 2);
});

test('image prep rejects malformed headers and mismatched decoded geometry', async (t) => {
  assert.equal(await prepareImageBlob(new Blob(['invalid'], { type: 'image/png' })), null);
  installGlobals(t, { Image: browserImage(2, 3) });
  assert.equal(await prepareImageBlob(imageBlob(PNG_BASE64, 'image/png')), null);
});

test('PNG encoding redraws into a canvas and falls back to JPEG at the original quality', async (t) => {
  const calls = [];
  const jpeg = new Blob(['jpeg fixture'], { type: 'image/jpeg' });
  const canvas = {
    getContext: (kind) => {
      assert.equal(kind, '2d');
      return { drawImage: (...args) => { calls.push(args.slice(1)); } };
    },
    toBlob: (resolve, type, quality) => { calls.push({ type, quality }); resolve(type === 'image/png' ? null : jpeg); },
  };
  installGlobals(t, { Image: browserImage(1, 1), document: {
    createElement: (tag) => { assert.equal(tag, 'canvas'); return canvas; },
  } });
  const prepared = await prepareImageBlob(imageBlob(PNG_BASE64, 'image/png'));
  assert.deepEqual(prepared, { blob: jpeg, nw: 1, nh: 1 });
  assert.deepEqual(calls, [[0, 0, 1, 1], { type: 'image/png', quality: undefined }, { type: 'image/jpeg', quality: 0.8 }]);
});

test('upload retries only 429 failures at 1100ms and stops at the attempt limit', async (t) => {
  const delays = [];
  let calls = 0;
  installGlobals(t, {
    setTimeout: (resolve, ms) => { delays.push(ms); queueMicrotask(resolve); },
    window: { storage: { uploadImage: async () => { calls += 1; throw new Error('image upload failed: 429'); } } },
  });
  await assert.rejects(uploadWithRetry(new Blob(), 3), /: 429$/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1100, 1100]);
  window.storage.uploadImage = async () => { throw new Error('image upload failed: 403'); };
  await assert.rejects(uploadWithRetry(new Blob()), /: 403$/);
  assert.deepEqual(delays, [1100, 1100]);
});

test('backup reads reject foreign sources and sanitization preserves non-image items', async () => {
  await assert.rejects(readBackupImage('https://foreign.example/image.png'), /another room or server/);
  const items = [{ id: 'sticky', type: 'sticky', text: 'keep' }];
  assert.deepEqual(await sanitizeImportedImages(items), items);
});

const RETIRED_IMAGE_ID = 'f98dcb70-f794-4b1a-9d4d-09fd5b4cd9a4';
const OTHER_ROOM_HANDLE = 'z'.repeat(32);
const retiredImageItem = (src) => ({ id: 'old', type: 'image', x: 0, y: 0, w: 120, h: 120, src, natW: 1, natH: 1 });
const exportOptions = (items) => ({ fallbackBoardCode: 'ROOMA', board: { items }, votes: new Map(), comments: new Map(), moods: {}, customTemplates: [] });

test('export embeds an image stored under the retired origin by reading it from the current server', async (t) => {
  const fetched = [];
  installGlobals(t, {
    window: { location: { origin: 'https://retroroom.party', hostname: 'retroroom.party', protocol: 'https:', pathname: '/' } },
    fetch: async (url) => { fetched.push(String(url)); return new Response(imageBlob(PNG_BASE64, 'image/png')); },
  });
  const stored = `https://retro.sagonzis.space/yjs/images/${RETIRED_IMAGE_ID}.png`;
  const artifact = await createPortableJsonBackupArtifact(exportOptions([retiredImageItem(stored)]), readBackupImage);
  assert.deepEqual(fetched, [`https://retroroom.party/yjs/images/${RETIRED_IMAGE_ID}.png`]);
  assert.match(artifact.contents, /data:image\/png;base64,/);
});

test('export still refuses a retired-origin image that names another room', async (t) => {
  const fetched = [];
  installGlobals(t, {
    window: { location: { origin: 'https://retroroom.party', hostname: 'retroroom.party', protocol: 'https:', pathname: '/' } },
    fetch: async (url) => { fetched.push(String(url)); return new Response(imageBlob(PNG_BASE64, 'image/png')); },
  });
  const stored = `https://retro.sagonzis.space/yjs/rooms/${OTHER_ROOM_HANDLE}/images/${RETIRED_IMAGE_ID}.png`;
  await assert.rejects(
    createPortableJsonBackupArtifact(exportOptions([retiredImageItem(stored)]), readBackupImage),
    /another room or server/,
  );
  assert.deepEqual(fetched, []);
});

test('image creation preflight stops over-quota uploads without hiding file validation errors', async () => {
  const { canStartImageImport } = await import('./image-upload.js');
  let checks = 0;
  const storage = { canCreateItems: () => { checks += 1; return false; } };
  assert.equal(canStartImageImport(null, storage), false);
  assert.equal(canStartImageImport({ type: 'image/png', size: 100 }, storage), false);
  assert.equal(checks, 1);
  assert.equal(canStartImageImport({ type: 'image/svg+xml', size: 100 }, storage), true);
  assert.equal(checks, 1);
  assert.equal(canStartImageImport({ type: 'image/png', size: 100 }, null), true);
});

test('canCreateImageItem asks the room quota for exactly one image and allows rooms without a quota', async () => {
  const { canCreateImageItem } = await import('./image-upload.js');
  const asked = [];
  assert.equal(canCreateImageItem({ canCreateItems: items => { asked.push(items); return false; } }), false);
  assert.deepEqual(asked, [[{ type: 'image' }]]);
  assert.equal(canCreateImageItem({}), true);
  assert.equal(canCreateImageItem(null), true);
});
