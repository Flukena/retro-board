import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { relayEntrypoint } from '../test-support/relay-entrypoint.js';
import { VOTE_EXPIRY_RETRY_INTERVAL_MS } from './relay-config.js';

const Y = createRequire(import.meta.url)('yjs');
const NOW_MS = 10_000;
const LATER_MS = 500;
const EARLIER_MS = 100;
const TIMER_MAX_MS = 2_147_483_647;

async function scheduler(t) {
  const state = await relayEntrypoint(t);
  const timers = [];
  const cleared = [];
  t.mock.method(Date, 'now', () => NOW_MS);
  t.mock.method(globalThis, 'setTimeout', function (callback, delayMs) {
    assert.ok(this === undefined || this === globalThis, 'timer keeps native receiver');
    const timer = { callback, delayMs, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', function (timer) {
    assert.ok(this === undefined || this === globalThis, 'clear keeps native receiver');
    cleared.push(timer);
  });
  const doc = new Y.Doc();
  doc.conns = new Map();
  await state.runtimePersistence.bindState('vote-test', doc);
  t.after(() => doc.destroy());
  const zone = (id, endsAt, type = 'zone') => {
    doc.getMap('items').set(id, new Y.Map(Object.entries({ type, voteTimer: { endsAt } })));
  };
  return { doc, zone, timers, cleared };
}

test('vote expiry selects earliest finite zone deadline and clears on destroy', async t => {
  const { doc, zone, timers, cleared } = await scheduler(t);
  zone('later', NOW_MS + LATER_MS);
  zone('earlier', NOW_MS + EARLIER_MS);
  zone('last-later', NOW_MS + LATER_MS);
  zone('invalid', NaN);
  zone('sticky', NOW_MS + 1, 'sticky');
  assert.equal(timers.at(-1).delayMs, EARLIER_MS);
  assert.ok(cleared.includes(timers[0]));
  const last = timers.at(-1);
  doc.destroy();
  assert.ok(cleared.includes(last));
});

test('unfinalizable expired votes use a retry floor and far deadlines use native timer cap', async t => {
  const { doc, zone, timers } = await scheduler(t);
  t.mock.method(console, 'warn', () => {});
  zone('expired', NOW_MS - 1);
  assert.equal(timers.at(-1).delayMs, 1);
  timers.at(-1).callback();
  assert.equal(timers.at(-1).delayMs, VOTE_EXPIRY_RETRY_INTERVAL_MS);
  doc.getMap('items').delete('expired');
  zone('far', NOW_MS + TIMER_MAX_MS + 1);
  assert.equal(timers.at(-1).delayMs, TIMER_MAX_MS);
});
