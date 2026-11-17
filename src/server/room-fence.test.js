import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomFence } from './room-fence.js';

const DOC = 'yjs/board-Fenced-abcdefgh12345678';
const OTHER = 'yjs/board-Other-abcdefgh12345678';
const SHORT_WAIT_MS = 20;
const LONG_WAIT_MS = 5_000;

test('entries are granted until the room is fenced, then refused for good', () => {
  const fence = new RoomFence();
  const release = fence.enter(DOC);
  assert.equal(typeof release, 'function');
  fence.fence(DOC);
  assert.equal(fence.isFenced(DOC), true);
  assert.equal(fence.enter(DOC), null);
  assert.equal(typeof fence.enter(OTHER), 'function', 'another room is untouched');
  release();
  assert.equal(fence.enter(DOC), null, 'releasing the last entry does not lift the fence');
});

test('drained resolves true at once when nothing is held', async () => {
  const fence = new RoomFence();
  fence.fence(DOC);
  assert.equal(await fence.drained(DOC, LONG_WAIT_MS), true);
});

test('drained waits for every held entry, and a double release counts once', async () => {
  const fence = new RoomFence();
  const first = fence.enter(DOC);
  const second = fence.enter(DOC);
  fence.fence(DOC);
  let settled = false;
  const drained = fence.drained(DOC, LONG_WAIT_MS).then((value) => { settled = true; return value; });
  first();
  first();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(settled, false, 'one entry is still held');
  second();
  assert.equal(await drained, true);
});

test('drained resolves false when an entry outlives the timeout, and true once it is released', async () => {
  const fence = new RoomFence();
  const release = fence.enter(DOC);
  fence.fence(DOC);
  assert.equal(await fence.drained(DOC, SHORT_WAIT_MS), false);
  const again = fence.drained(DOC, LONG_WAIT_MS);
  release();
  assert.equal(await again, true);
});

test('lift ends the fenced state so the name can be entered again', () => {
  const fence = new RoomFence();
  fence.fence(DOC);
  fence.lift(DOC);
  assert.equal(fence.isFenced(DOC), false);
  assert.equal(typeof fence.enter(DOC), 'function');
});
