import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directorySizeSync, loadSessionSigningKey } from './relay-local-files.js';

const SIGNING_KEY_BYTES = 32;
const PRIVATE_FILE_MODE = 0o600;
test('relay file extraction preserves stable private session keys and recursive disk accounting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-local-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = process.env.YJS_SESSION_SECRET;
  delete process.env.YJS_SESSION_SECRET;
  t.after(() => { if (original === undefined) delete process.env.YJS_SESSION_SECRET; else process.env.YJS_SESSION_SECRET = original; });
  assert.equal(directorySizeSync(root), 0);
  const key = loadSessionSigningKey(root);
  assert.equal(key.byteLength, SIGNING_KEY_BYTES);
  assert.deepEqual(loadSessionSigningKey(root), key);
  const path = join(root, '.room-session-key');
  assert.equal((await stat(path)).mode & 0o777, PRIVATE_FILE_MODE);
  assert.equal(directorySizeSync(root), (await readFile(path)).byteLength);
  await writeFile(path, 'invalid');
  assert.throws(() => loadSessionSigningKey(root), /invalid persisted/);
});

test('public database accounting excludes only the root history directory', async t => {
  const { PUBLIC_SNAPSHOT_DIRECTORY } = await import('./public-wall-config.js');
  const root = await mkdtemp(join(tmpdir(), 'wall-db-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, PUBLIC_SNAPSHOT_DIRECTORY));
  await writeFile(join(root, PUBLIC_SNAPSHOT_DIRECTORY, 'wall-1700000000000.bin'), 'history');
  await writeFile(join(root, 'CURRENT'), 'db');
  await mkdir(join(root, 'nested', PUBLIC_SNAPSHOT_DIRECTORY), { recursive: true });
  await writeFile(join(root, 'nested', PUBLIC_SNAPSHOT_DIRECTORY, 'keep'), 'keep');
  assert.equal(directorySizeSync(root, { excludedRootDirectories: [PUBLIC_SNAPSHOT_DIRECTORY] }), 6);
  assert.equal(directorySizeSync(root), 13);
  const source = await readFile(new URL('../../yjs-server.mjs', import.meta.url), 'utf8');
  const measureSource = source.split('\n').find(line => line.startsWith('const databaseSizeBytes ='));
  const measure = runInNewContext(`${measureSource}\ndatabaseSizeBytes;`, { directorySizeSync, DB_DIR: root, PUBLIC_WALL: true, PUBLIC_SNAPSHOT_DIRECTORY });
  assert.equal(measure(), 6, 'the actual relay measurement must use the non-overlapping budget');
});
