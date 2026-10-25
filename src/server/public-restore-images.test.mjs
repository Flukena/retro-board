import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { mkdtemp, mkdir, writeFile, readFile, stat, link, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restorePublicImages } from './public-restore-images.js';

const OLD_HANDLE = 'A'.repeat(32);
const HISTORICAL_HANDLE = 'B'.repeat(32);
const NEW_HANDLE = 'C'.repeat(32);
const IMAGE_ID = 'abcdef01.png';
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function fixture(context, src = `/yjs-public/rooms/${OLD_HANDLE}/images/${IMAGE_ID}`) {
  const root = await mkdtemp(join(tmpdir(), 'public-restore-images-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databaseDirectory = join(root, 'db');
  const uploadsDirectory = join(root, 'uploads');
  await Promise.all([mkdir(databaseDirectory), mkdir(uploadsDirectory)]);
  const doc = new Y.Doc();
  context.after(() => doc.destroy());
  const image = new Y.Map(Object.entries({ type: 'image', src, x: 0, y: 0, w: 100, h: 100 }));
  doc.getMap('items').set('image', image);
  return { doc, image, databaseDirectory, uploadsDirectory, roomHandle: NEW_HANDLE };
}

test('restore hardlinks real public bytes under the rotated handle and rewrites canonical image references', async context => {
  const setup = await fixture(context);
  const original = join(setup.uploadsDirectory, `${OLD_HANDLE}.${IMAGE_ID}`);
  await writeFile(original, IMAGE_BYTES);
  assert.equal(await restorePublicImages(setup.doc, setup), true);
  assert.equal(setup.image.get('src'), `/yjs-public/rooms/${NEW_HANDLE}/images/${IMAGE_ID}`);
  const restored = join(setup.uploadsDirectory, `${NEW_HANDLE}.${IMAGE_ID}`);
  assert.deepEqual(await readFile(restored), IMAGE_BYTES);
  const [before, after] = await Promise.all([stat(original), stat(restored)]);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
});

test('older snapshots remain restorable when historical handles already share the same public inode', async context => {
  const setup = await fixture(context);
  const original = join(setup.uploadsDirectory, `${HISTORICAL_HANDLE}.${IMAGE_ID}`);
  await writeFile(original, IMAGE_BYTES);
  await link(original, join(setup.uploadsDirectory, `${OLD_HANDLE}.${IMAGE_ID}`));
  assert.equal(await restorePublicImages(setup.doc, setup), true);
  assert.equal(setup.image.get('src'), `/yjs-public/rooms/${NEW_HANDLE}/images/${IMAGE_ID}`);
});

test('missing or ambiguous public image files fail before rewriting the restored document', async context => {
  const setup = await fixture(context);
  const originalSource = setup.image.get('src');
  await assert.rejects(restorePublicImages(setup.doc, setup), /missing/);
  await writeFile(join(setup.uploadsDirectory, `${OLD_HANDLE}.${IMAGE_ID}`), IMAGE_BYTES);
  await writeFile(join(setup.uploadsDirectory, `${HISTORICAL_HANDLE}.${IMAGE_ID}`), IMAGE_BYTES);
  await assert.rejects(restorePublicImages(setup.doc, setup), /ambiguous/);
  assert.equal(setup.image.get('src'), originalSource);
});

test('restore rejects private or traversal image paths and never follows public-upload symlinks', async context => {
  const setup = await fixture(context, `/yjs/rooms/${OLD_HANDLE}/images/${IMAGE_ID}`);
  await assert.rejects(restorePublicImages(setup.doc, setup), /image source/);
  setup.image.set('src', `/yjs-public/rooms/${OLD_HANDLE}/images/../${IMAGE_ID}`);
  await assert.rejects(restorePublicImages(setup.doc, setup), /image source/);
  setup.image.set('src', `/yjs-public/rooms/${OLD_HANDLE}/images/${IMAGE_ID}`);
  const outside = join(setup.databaseDirectory, IMAGE_ID);
  await writeFile(outside, IMAGE_BYTES);
  await symlink(outside, join(setup.uploadsDirectory, `${OLD_HANDLE}.${IMAGE_ID}`));
  await assert.rejects(restorePublicImages(setup.doc, setup), /missing/);
});

test('restore leaves text-only snapshots unchanged without needing an upload directory', async () => {
  const doc = new Y.Doc();
  try {
    doc.getMap('items').set('text', new Y.Map([['type', 'text'], ['text', 'Keep me']]));
    const before = Y.encodeStateAsUpdate(doc);
    assert.equal(await restorePublicImages(doc, { roomHandle: NEW_HANDLE }), false);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { doc.destroy(); }
});
