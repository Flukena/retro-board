import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { decryptFrame, encryptFrame } from '../room-lock/e2e-crypto.js';
import { E2E_SYNCED_FIELD } from './e2e-provider.js';
import { attachE2EVoteExpiry, electedFinalizer } from './e2e-vote-expiry.js';
import { delivered, e2eRoom, roomKey, sleep, synced, until } from '../../test-support/e2e-room-fixture.mjs';

const GRACE_MS = 300;
const DEADLINE_IN_MS = 200;
const MARGIN_MS = 100;
const ZONE = Object.freeze({ type: 'zone', x: 0, y: 0, w: 600, h: 500 });
const CARD = Object.freeze({ type: 'sticky', x: 20, y: 120, parentZoneId: 'zone' });
const TIMER_EXPIRY_ORIGIN = 'timer-expiry';
const failOnInvalid = () => assert.fail('valid geometry was rejected');

const startVote = ({ doc }, endsAt, startedAt = 1) => doc.transact(() => {
  const items = doc.getMap('items');
  if (!items.has('zone')) {
    items.set('zone', new Y.Map(Object.entries(ZONE)));
    items.set('card', new Y.Map(Object.entries(CARD)));
  }
  items.get('zone').set('voteTimer', { startedAt, endsAt });
}, 'local');
const timerOf = ({ doc }) => doc.getMap('items').get('zone')?.get('voteTimer') ?? null;
const countFinalizations = ({ doc }) => {
  const counter = { count: 0 };
  doc.on('afterTransaction', (transaction) => {
    if (transaction.origin === TIMER_EXPIRY_ORIGIN && transaction.changed.size > 0) counter.count += 1;
  });
  return counter;
};
const expire = (peer, t, options = {}) => {
  const expiry = attachE2EVoteExpiry({ ydoc: peer.doc, provider: peer.provider, graceMs: GRACE_MS, onInvalidGeometry: failOnInvalid, ...options });
  t.after(() => expiry.destroy());
  return expiry;
};
const seesSynced = (peer, clientIDs) => until(
  () => clientIDs.every((id) => peer.provider.awareness.getStates().get(id)?.[E2E_SYNCED_FIELD] === true),
  'e2eSynced awareness',
);

test('the elected page finalizes once at the deadline; the other page\'s grace pass changes nothing', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key, { clientID: 1 });
  const b = room.join(key, { clientID: 2 });
  await synced(a, b);
  await Promise.all([seesSynced(a, [1, 2]), seesSynced(b, [1, 2])]);
  assert.equal(electedFinalizer(b.provider.awareness), 1);
  const [finalA, finalB] = [countFinalizations(a), countFinalizations(b)];
  expire(a, t);
  expire(b, t);
  const endsAt = Date.now() + DEADLINE_IN_MS;
  startVote(a, endsAt);
  await until(() => timerOf(b) === null && timerOf(a) === null, 'finalized everywhere');
  assert.ok(Date.now() < endsAt + GRACE_MS, 'finalized by the elected page before the grace');
  await sleep(GRACE_MS + MARGIN_MS);
  assert.deepEqual([finalA.count, finalB.count], [1, 0]);
  assert.equal(b.doc.getMap('items').get('zone').get('lastResultsAt'), endsAt);
});

test('when the elected page does not act, another page finalizes after the grace, once', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key, { clientID: 1 });
  const b = room.join(key, { clientID: 2 });
  await synced(a, b);
  await seesSynced(b, [1, 2]);
  const finalB = countFinalizations(b);
  expire(b, t);
  const endsAt = Date.now() + DEADLINE_IN_MS;
  startVote(a, endsAt);
  await sleep(DEADLINE_IN_MS + MARGIN_MS);
  assert.notEqual(timerOf(b), null, 'the non-elected page waits for the grace');
  await until(() => timerOf(a) === null, 'finalized after the grace');
  await sleep(MARGIN_MS);
  assert.equal(finalB.count, 1);
});

test('a replaced timer is not finalized at its old deadline', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key, { clientID: 1 });
  await synced(a);
  await seesSynced(a, [1]);
  expire(a, t);
  const start = Date.now();
  startVote(a, start + DEADLINE_IN_MS, 1);
  const replacedEndsAt = start + DEADLINE_IN_MS * 3;
  startVote(a, replacedEndsAt, 2);
  await sleep(DEADLINE_IN_MS + MARGIN_MS);
  assert.deepEqual(timerOf(a), { startedAt: 2, endsAt: replacedEndsAt });
  await until(() => timerOf(a) === null, 'the replacement is finalized');
  assert.equal(a.doc.getMap('items').get('zone').get('lastResultsAt'), replacedEndsAt);
});

test('a page still replaying the log at the deadline waits, then finalizes once it holds the whole log', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  let gate = null;
  const gated = {
    encryptFrame,
    async decryptFrame(...args) {
      await gate;
      return decryptFrame(...args);
    },
  };
  const a = room.join(key, { clientID: 1, cipher: gated });
  await synced(a);
  await seesSynced(a, [1]);
  const finalA = countFinalizations(a);
  expire(a, t);
  const endsAt = Date.now() + DEADLINE_IN_MS;
  startVote(a, endsAt);
  await delivered(a);
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  a.tap.last.close();
  await until(() => a.provider.wsconnected, 'reconnected');
  await sleep(DEADLINE_IN_MS + MARGIN_MS);
  assert.equal(a.provider.e2eSynced, false);
  assert.notEqual(timerOf(a), null, 'no finalization from a partial replay');
  release();
  await until(() => timerOf(a) === null, 'finalized after the replay');
  assert.equal(finalA.count, 1);
});

test('a timer that fires before the clock reaches the deadline re-arms instead of giving up', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key, { clientID: 1 });
  await synced(a);
  await seesSynced(a, [1]);
  const DEADLINE = 1_000;
  const clock = { now: DEADLINE - 1, scheduled: [] };
  const timers = {
    now: () => clock.now,
    setTimeout: (callback) => clock.scheduled.push(callback),
    clearTimeout: () => {},
  };
  expire(a, t, { timers });
  startVote(a, DEADLINE);
  clock.scheduled.pop()();
  assert.notEqual(timerOf(a), null, 'nothing is due a millisecond early');
  clock.now = DEADLINE;
  clock.scheduled.pop()();
  assert.equal(timerOf(a), null);
});
