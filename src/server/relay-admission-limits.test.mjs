import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmissionLimits } from './relay-admission-limits.js';
import { readRelayConfig } from './relay-config.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const BUCKET_NAMES = ['roomCreate', 'roomCreateGlobal', 'sessionExchange', 'sessionExchangeGlobal', 'sessionFailure', 'wsUpgradeIp', 'wsUpgradeRoom', 'wsUpgradeGlobal', 'coldRoomOpenIp', 'coldRoomOpenRoom', 'coldRoomOpenGlobal'];
function setup(overrides = {}) {
  let timeMs = 0;
  const buckets = Object.fromEntries(BUCKET_NAMES.map(name => [name, new Map()]));
  const config = { ...readRelayConfig({}), ROOM_CREATE_BURST: 2, ROOM_CREATES_PER_HOUR: 60,
    GLOBAL_ROOM_CREATE_BURST: 3, GLOBAL_ROOM_CREATES_PER_MINUTE: 1,
    SESSION_EXCHANGE_BURST: 2, SESSION_EXCHANGES_PER_MINUTE: 1,
    GLOBAL_SESSION_EXCHANGE_BURST: 3, GLOBAL_SESSION_EXCHANGES_PER_MINUTE: 1,
    SESSION_FAILURE_BURST: 2, SESSION_FAILURES_PER_HOUR: 2,
    WS_UPGRADE_IP_BURST: 2, WS_UPGRADES_PER_IP_PER_MINUTE: 1,
    WS_UPGRADE_ROOM_BURST: 2, WS_UPGRADES_PER_ROOM_PER_MINUTE: 1,
    GLOBAL_WS_UPGRADE_BURST: 3, GLOBAL_WS_UPGRADES_PER_MINUTE: 1,
    COLD_ROOM_OPEN_IP_BURST: 1, COLD_ROOM_OPENS_PER_IP_PER_MINUTE: 1,
    COLD_ROOM_OPEN_ROOM_BURST: 1, COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE: 1,
    GLOBAL_COLD_ROOM_OPEN_BURST: 1, GLOBAL_COLD_ROOM_OPENS_PER_MINUTE: 1, ...overrides };
  const now = () => timeMs;
  return { limits: createAdmissionLimits(config, buckets, now), buckets, config, now, advance: ms => { timeMs += ms; } };
}
test('create rejects atomically, rounds retry seconds and refills on injected time', () => {
  const { limits, buckets, advance } = setup();
  assert.equal(limits.takeCreateToken('ip'), 0);
  assert.equal(limits.takeCreateToken('ip'), 0);
  assert.equal(limits.takeCreateToken('ip'), 60);
  assert.equal(buckets.roomCreateGlobal.get('global').tokens, 1);
  advance(1);
  assert.equal(limits.takeCreateToken('ip'), 60);
  advance(MINUTE_MS - 1);
  assert.equal(limits.takeCreateToken('ip'), 0);
});
test('global create exhaustion leaves a fresh IP reservation intact', () => {
  const { limits, buckets } = setup({ GLOBAL_ROOM_CREATE_BURST: 1 });
  assert.equal(limits.takeCreateToken('a'), 0);
  assert.equal(limits.takeCreateToken('b'), 60);
  assert.equal(buckets.roomCreate.get('b').tokens, 2);
});
test('session reservations reject atomically and refill at the minute boundary', () => {
  const { limits, buckets, advance } = setup();
  assert.equal(limits.takeSessionExchangeToken('ip'), true);
  assert.equal(limits.takeSessionExchangeToken('ip'), true);
  assert.equal(limits.takeSessionExchangeToken('ip'), false);
  assert.equal(buckets.sessionExchangeGlobal.get('global').tokens, 1);
  advance(MINUTE_MS);
  assert.equal(limits.takeSessionExchangeToken('ip'), true);
});
test('session failures consume only when recorded, floor at zero and recover', () => {
  const { limits, buckets, advance } = setup();
  assert.equal(limits.failureAttemptAvailable('ip'), true);
  assert.equal(limits.failureAttemptAvailable('ip'), true);
  limits.recordSessionFailure('ip'); limits.recordSessionFailure('ip'); limits.recordSessionFailure('ip');
  assert.equal(limits.failureAttemptAvailable('ip'), false);
  assert.equal(buckets.sessionFailure.get('ip').tokens, 0);
  advance(HOUR_MS / 2);
  assert.equal(limits.failureAttemptAvailable('ip'), true);
});
test('warm upgrades never consume cold budgets; cold failure does not spend warm tokens', () => {
  const { limits, buckets, advance } = setup();
  assert.equal(limits.takeWsUpgradeToken('ip', 'room', false), true);
  assert.equal(buckets.coldRoomOpenGlobal.size, 0);
  assert.equal(limits.takeWsUpgradeToken('ip', 'room', true), true);
  assert.equal(limits.takeWsUpgradeToken('other', 'other-room', true), false);
  assert.equal(buckets.wsUpgradeIp.get('other').tokens, 2);
  assert.equal(buckets.wsUpgradeGlobal.get('global').tokens, 1);
  advance(MINUTE_MS);
  assert.equal(limits.takeWsUpgradeToken('other', 'other-room', true), true);
});
for (const [name, overrides, calls] of [
  ['IP', { WS_UPGRADE_IP_BURST: 1 }, [['a', 'one'], ['a', 'two']]],
  ['room', { WS_UPGRADE_ROOM_BURST: 1 }, [['a', 'one'], ['b', 'one']]],
  ['global', { GLOBAL_WS_UPGRADE_BURST: 1 }, [['a', 'one'], ['b', 'two']]],
]) test(`upgrade exhaustion at ${name} scope refuses`, () => {
  const { limits } = setup(overrides);
  assert.equal(limits.takeWsUpgradeToken(...calls[0], false), true);
  assert.equal(limits.takeWsUpgradeToken(...calls[1], false), false);
});
test('evicts the least recently seen bucket and caps refill at burst', () => {
  const { limits, buckets, advance } = setup({ MAX_BUCKETS: 2 });
  limits.takeCreateToken('a'); advance(1); limits.takeCreateToken('b');
  advance(1); limits.failureAttemptAvailable('unused'); limits.takeCreateToken('a');
  advance(1); limits.takeCreateToken('c');
  assert.deepEqual([...buckets.roomCreate.keys()], ['a', 'c']);
  advance(HOUR_MS);
  limits.takeCreateToken('a');
  assert.equal(buckets.roomCreate.get('a').tokens, 1);
});
test('all controllers share the injected maps rather than copied reservations', () => {
  const { limits, buckets, config, now } = setup({ GLOBAL_ROOM_CREATE_BURST: 1 });
  const peer = createAdmissionLimits(config, buckets, now);
  assert.equal(limits.takeCreateToken('a'), 0);
  assert.equal(peer.takeCreateToken('b'), 60);
  buckets.roomCreateGlobal.get('global').tokens = 1;
  assert.equal(peer.takeCreateToken('b'), 0);
});
