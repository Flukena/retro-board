import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('hourly history is atomic, keeps 48 encoded states and skips unchanged docs', async t => {
  const { PublicWallHistory } = await import('./public-wall-history.js');
  const root = await mkdtemp(join(tmpdir(), 'wall-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const history = new PublicWallHistory(root, Y);
  const startMs = 1700000000000;
  const hourMs = 3600000;
  for (let index = 0; index < 50; index++) {
    doc.getMap('meta').set('count', index);
    await history.maintain(doc, startMs + index * hourMs);
  }
  const files = (await readdir(join(root, 'snapshots'))).sort();
  assert.equal(files.length, 48);
  assert.equal(files.every(name => /^wall-\d{13}\.bin$/.test(name)), true);
  const restored = new Y.Doc();
  t.after(() => restored.destroy());
  Y.applyUpdate(restored, await readFile(join(root, 'snapshots', files.at(-1))));
  assert.equal(restored.getMap('meta').get('count'), 49);
  await history.maintain(doc, startMs + 51 * hourMs);
  assert.deepEqual((await readdir(join(root, 'snapshots'))).sort(), files);
});
test('public directory marker refuses existing private storage and allows an empty dedicated directory', async t => {
  const { claimPublicDirectory } = await import('./public-wall-history.js');
  const root = await mkdtemp(join(tmpdir(), 'wall-marker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'CURRENT'), 'private database');
  assert.throws(() => claimPublicDirectory(root), /unmarked/);
  await rm(join(root, 'CURRENT'));
  claimPublicDirectory(root);
  claimPublicDirectory(root);
  assert.equal((await readdir(root)).includes('.public-wall-v1'), true);
});

test('changed history is throttled for an hour and a failed atomic write can be retried', async t => {
  const { PublicWallHistory } = await import('./public-wall-history.js');
  const root = await mkdtemp(join(tmpdir(), 'wall-history-throttle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const history = new PublicWallHistory(root, Y);
  const startMs = 1700000000000;
  const hourMs = 3600000;
  await writeFile(join(root, 'snapshots'), 'blocked');
  await assert.rejects(history.maintain(doc, startMs));
  await rm(join(root, 'snapshots'));
  await history.maintain(doc, startMs);
  const first = await readdir(join(root, 'snapshots'));
  doc.getMap('meta').set('changed', true);
  await history.maintain(doc, startMs + hourMs - 1);
  assert.deepEqual(await readdir(join(root, 'snapshots')), first);
  await history.maintain(doc, startMs + hourMs);
  assert.equal((await readdir(join(root, 'snapshots'))).length, 2);
});

test('history enforces a separate byte budget before writes and retains the newest recovery point', async t => {
  const { PublicWallHistory } = await import('./public-wall-history.js');
  const root = await mkdtemp(join(tmpdir(), 'wall-history-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const startMs = 1700000000000;
  const hourMs = 3600000;
  const budgetBytes = 200;
  const history = new PublicWallHistory(root, Y, { maxTotalBytes: budgetBytes });
  for (let index = 0; index < 4; index++) {
    doc.getMap('meta').set('text', String(index).repeat(80));
    await history.maintain(doc, startMs + index * hourMs);
    const files = (await readdir(join(root, 'snapshots'))).sort();
    const sizes = await Promise.all(files.map(file => readFile(join(root, 'snapshots', file))));
    assert.ok(sizes.reduce((total, bytes) => total + bytes.byteLength, 0) <= budgetBytes);
    assert.equal(files.at(-1), `wall-${startMs + index * hourMs}.bin`);
  }
});

test('an oversized history state is rejected without deleting the last usable recovery point', async t => {
  const { PublicWallHistory } = await import('./public-wall-history.js');
  const root = await mkdtemp(join(tmpdir(), 'wall-history-oversize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const budgetBytes = 100;
  const oversizedTextCharacters = 1000;
  const history = new PublicWallHistory(root, Y, { maxTotalBytes: budgetBytes });
  const startMs = 1700000000000;
  const hourMs = 3600000;
  await history.maintain(doc, startMs);
  const before = await readdir(join(root, 'snapshots'));
  doc.getMap('meta').set('text', 'x'.repeat(oversizedTextCharacters));
  await assert.rejects(history.maintain(doc, startMs + hourMs), /history byte budget/);
  assert.deepEqual(await readdir(join(root, 'snapshots')), before);
});
