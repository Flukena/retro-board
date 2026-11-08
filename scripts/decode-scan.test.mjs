import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOM_LOCK_META, encodeLockRecord } from '../src/server/room-lock-record.js';
import { lockRecord } from '../src/server/room-lock-fixtures.mjs';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const run = promisify(execFile);

const NORMAL_DOC = 'yjs/board-plain-aaaaaaaa';
const LOCKED_DOC = 'yjs/board-locked-bbbbbbbb';
const MALFORMED_DOCS = [['yjs/board-falsy-cccccccc', false], ['yjs/board-zero-dddddddd', 0], ['yjs/board-empty-eeeeeeee', '']];
const NORMAL_ITEMS = 1;
const LOCKED_ITEMS = 3;

const docWithItems = (count) => {
  const doc = new Y.Doc();
  for (let i = 0; i < count; i += 1) doc.getMap('items').set(`item-${i}`, new Y.Map([['type', 'sticky']]));
  return Y.encodeStateAsUpdate(doc);
};

test('decode-scan counts normal rooms and skips documents that carry any room lock meta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decode-scan-'));
  try {
    const ldb = new LeveldbPersistence(dir);
    await ldb.storeUpdate(NORMAL_DOC, docWithItems(NORMAL_ITEMS));
    await ldb.storeUpdate(LOCKED_DOC, docWithItems(LOCKED_ITEMS));
    await ldb.setMeta(LOCKED_DOC, ROOM_LOCK_META, encodeLockRecord(lockRecord()));
    for (const [docName, value] of MALFORMED_DOCS) {
      await ldb.storeUpdate(docName, docWithItems(LOCKED_ITEMS));
      await ldb.setMeta(docName, ROOM_LOCK_META, value);
    }
    await ldb.destroy();
    const { stdout } = await run(process.execPath, ['scripts/decode-scan.mjs', dir]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.rooms, 2 + MALFORMED_DOCS.length);
    assert.equal(summary.skippedEncrypted, 1 + MALFORMED_DOCS.length, 'any present lock meta, even malformed, fails closed');
    assert.equal(summary.items, NORMAL_ITEMS, 'the encrypted room items are never read');
    assert.equal(summary.roomMiB.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
