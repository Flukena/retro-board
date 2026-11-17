import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { MINUTE_MS } from '../../domain/countdown.js';
import { WRITING_TIMER_PHASE } from '../../domain/writing-timer.js';
import { WRITING_TIMER_MAP, createWritingTimerStore } from './writing-timer-store.js';

const ADMIN_NOW_MS = 1_800_000_000_000;
const SECOND_MS = 1000;
const AHEAD_MS = 2 * MINUTE_MS;
const BEHIND_MS = 11 * SECOND_MS;
const RELAY = 'relay';

/** One page: its doc, its wall clock (`clock.now`), whether its provider counts as synced, and its store. */
function page(t, { skewMs = 0, live = true } = {}) {
  const doc = new Y.Doc();
  const clock = { now: ADMIN_NOW_MS + skewMs };
  const sync = { live };
  let ids = 0;
  const store = createWritingTimerStore({
    doc, isLive: () => sync.live, now: () => clock.now, createId: () => `timer-${ids += 1}`,
  });
  t.after(() => { store.destroy(); doc.destroy(); });
  return { doc, clock, sync, store };
}

/** Relays every later update between the pages, as the provider does. */
function link(...pages) {
  for (const from of pages) {
    from.doc.on('update', (update, origin) => {
      if (origin === RELAY) return;
      pages.filter((to) => to !== from).forEach((to) => Y.applyUpdate(to.doc, update, RELAY));
    });
  }
}

const advance = (pages, ms) => pages.forEach((one) => { one.clock.now += ms; });

test('a page with a clock 2 min ahead or 11 s behind sees the full run the admin started', (t) => {
  const admin = page(t);
  const ahead = page(t, { skewMs: AHEAD_MS });
  const behind = page(t, { skewMs: -BEHIND_MS });
  link(admin, ahead, behind);
  assert.equal(admin.store.start(3), true);
  for (const one of [admin, ahead, behind]) assert.equal(one.store.view().label, '03:00');
  advance([admin, ahead, behind], MINUTE_MS);
  for (const one of [admin, ahead, behind]) assert.equal(one.store.view().label, '02:00');
});

test('+1 and stop reach every page', (t) => {
  const admin = page(t);
  const reader = page(t, { skewMs: AHEAD_MS });
  link(admin, reader);
  admin.store.start(3);
  advance([admin, reader], MINUTE_MS);
  assert.equal(admin.store.extend(), true);
  assert.equal(reader.store.view().label, '03:00', '2:00 left + 1:00');
  assert.equal(admin.store.stop(), true);
  assert.equal(reader.store.view().phase, WRITING_TIMER_PHASE.IDLE);
  assert.equal(admin.store.view().phase, WRITING_TIMER_PHASE.IDLE);
});

test('a late joiner counts what it finds in the initial sync against its own clock', (t) => {
  const admin = page(t);
  admin.store.start(3);
  advance([admin], 30 * SECOND_MS);
  const joiner = page(t, { live: false });
  joiner.clock.now = admin.clock.now;
  Y.applyUpdate(joiner.doc, Y.encodeStateAsUpdate(admin.doc), RELAY);
  joiner.sync.live = true;
  assert.equal(joiner.store.view().label, '02:30');
});

test('an update that arrives while a page resyncs after a reconnect is not counted as live', (t) => {
  const admin = page(t);
  const reader = page(t, { skewMs: AHEAD_MS });
  link(admin, reader);
  admin.store.start(3);
  reader.sync.live = false;
  advance([admin, reader], MINUTE_MS);
  admin.store.extend();
  // Delivered late, so its own receipt says nothing about when it was written: the reader's clock decides.
  const endsAt = ADMIN_NOW_MS + 4 * MINUTE_MS;
  assert.equal(reader.store.view().remainingMs, endsAt - reader.clock.now);
});

test('listeners hear changes until they unsubscribe; nothing is heard after destroy', (t) => {
  const admin = page(t);
  const heard = [];
  const unsubscribe = admin.store.subscribe(() => heard.push(admin.store.view().phase));
  admin.store.start(5);
  unsubscribe();
  admin.store.stop();
  assert.deepEqual(heard, [WRITING_TIMER_PHASE.RUNNING]);
  admin.store.subscribe(() => heard.push('after destroy'));
  admin.store.destroy();
  admin.store.start(5);
  assert.deepEqual(heard, [WRITING_TIMER_PHASE.RUNNING]);
});

test('a malformed value from a peer shows nothing', (t) => {
  const reader = page(t);
  reader.doc.getMap(WRITING_TIMER_MAP).set('current', { id: 'x', writtenAt: ADMIN_NOW_MS, endsAt: ADMIN_NOW_MS + 1 });
  assert.equal(reader.store.view().phase, WRITING_TIMER_PHASE.IDLE);
  assert.equal(reader.store.extend(), false, 'nothing to extend');
});

test("the end is reported once per page, and Time's up shows meanwhile", (t) => {
  const admin = page(t);
  const reader = page(t, { skewMs: -BEHIND_MS });
  link(admin, reader);
  admin.store.start(1);
  advance([admin, reader], MINUTE_MS);
  for (const one of [admin, reader]) {
    assert.equal(one.store.takeExpiry(), true);
    assert.equal(one.store.takeExpiry(), false);
    assert.equal(one.store.view().phase, WRITING_TIMER_PHASE.TIMES_UP);
  }
});
