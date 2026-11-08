import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { PASSWORD, createLockedRoom, lockedRelay } from '../../test-support/locked-room-harness.mjs';
import { installBrowserStandIn } from '../../test-support/browser-stand-in.mjs';
import { createNextRoomKey, createRoomLock } from '../room-lock/e2e-crypto.js';
import { clearRoomKey, getRoomKey, unlockRoom } from '../room-lock/lock-session.js';
import { uploadEncryptedImage } from '../room-lock/e2e-images.js';
import { repairOldEpochImages } from '../room-lock/e2e-image-repair.js';
import { createImageRepairScheduler } from './e2e-image-repair-schedule.js';
import { listImageSources, rewriteImageSources } from './item-image-sources.js';

const ROOM_LOCK = await createRoomLock(PASSWORD);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const DEBOUNCE_MS = 10;
const WAIT_MS = 5000;
const POLL_MS = 10;
const QUIET_MS = 80;
const image = () => new Blob([PNG], { type: 'image/png' });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(check, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
    await sleep(POLL_MS);
  }
}

async function setup(t) {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env, ROOM_LOCK);
  installBrowserStandIn(t, env.relay.url, ROOM_LOCK.authKey);
  t.after(clearRoomKey);
  await unlockRoom({ code: room.code, token: room.token, password: PASSWORD, lockHint: { salt: ROOM_LOCK.lock.salt, kdf: ROOM_LOCK.lock.kdf } });
  const first = getRoomKey();
  const next = await createNextRoomKey('another long password');
  const key = { ...first, keyEpoch: 1, dek: next.dek, previousKeys: new Map([[0, first.dek]]) };
  const doc = new Y.Doc();
  const items = doc.getMap('items');
  const storage = {
    listImageSources: () => listImageSources(items),
    rewriteImageSources: (map) => rewriteImageSources(doc, items, map, 'image-repair', key.roomHandle),
  };
  const add = (id, src) => { const item = new Y.Map([['type', 'image'], ['src', src]]); items.set(id, item); };
  const provider = { appliedSeq: 0, head: 3 };
  const scheduler = createImageRepairScheduler({
    ydoc: doc, provider, getRoomKey: () => key, repair: () => repairOldEpochImages({ storage, key }), debounceMs: DEBOUNCE_MS,
  });
  t.after(() => scheduler.destroy());
  const oldSrc = () => uploadEncryptedImage(image(), { key: { ...first, keyEpoch: 0 } });
  return { items, add, provider, scheduler, oldSrc, srcOf: (id) => items.get(id).get('src') };
}

test('repair waits until the log is fully read, then repairs references that replay brought in late', async (t) => {
  const { add, provider, scheduler, oldSrc, srcOf } = await setup(t);
  const early = await oldSrc();
  add('early', early);
  scheduler.request();
  await sleep(QUIET_MS);
  assert.equal(srcOf('early'), early, 'not synced yet: nothing rewritten');
  const late = await oldSrc();
  provider.appliedSeq = provider.head;
  add('late', late);
  await until(() => srcOf('early') !== early && srcOf('late') !== late, 'both old references repaired');
});

test('a reference that arrives after a completed repair is repaired by the next change', async (t) => {
  const { add, provider, scheduler, oldSrc, srcOf } = await setup(t);
  provider.appliedSeq = provider.head;
  const first = await oldSrc();
  add('one', first);
  scheduler.request();
  await until(() => srcOf('one') !== first, 'first repaired');
  const second = await oldSrc();
  add('two', second);
  await until(() => srcOf('two') !== second, 'second repaired');
});

test('nothing is scheduled without an earlier key', async () => {
  const calls = [];
  const idle = createImageRepairScheduler({
    ydoc: new Y.Doc(), provider: { appliedSeq: 1, head: 1 }, getRoomKey: () => ({ previousKeys: new Map() }),
    repair: () => calls.push('run'), debounceMs: DEBOUNCE_MS,
  });
  idle.request();
  await sleep(QUIET_MS);
  assert.deepEqual(calls, []);
  idle.destroy();
});
