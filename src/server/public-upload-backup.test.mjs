import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';

const ROOM_HANDLE = 'a'.repeat(32);
const IMAGE_ID = '12345678-abcd.png';
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('public backup verifies persisted raster references and rejects missing or empty public files', async t => {
  const { verifyPublicUploadFiles } = await import('./public-upload-backup.js');
  const directory = await mkdtemp(join(tmpdir(), 'public-upload-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  doc.getMap('items').set('photo', new Y.Map([
    ['type', 'image'], ['src', `/yjs-public/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}`],
  ]));
  await assert.rejects(verifyPublicUploadFiles(doc, directory), /public image/);
  const filename = join(directory, `${ROOM_HANDLE}.${IMAGE_ID}`);
  await writeFile(filename, PNG_HEADER);
  assert.equal(await verifyPublicUploadFiles(doc, directory), 1);
  await writeFile(filename, '');
  await assert.rejects(verifyPublicUploadFiles(doc, directory), /public image/);
});

test('legacy backups with no public images need no image directory and never inspect external URLs', async t => {
  const { verifyPublicUploadFiles } = await import('./public-upload-backup.js');
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  assert.equal(await verifyPublicUploadFiles(doc, '/missing-legacy-public-uploads'), 0);
  doc.getMap('items').set('unsafe', new Y.Map([
    ['type', 'image'], ['src', 'https://external.example/tracking.png'],
  ]));
  assert.equal(await verifyPublicUploadFiles(doc, '/missing-legacy-public-uploads'), 0);
});
