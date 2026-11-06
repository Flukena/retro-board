import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, entitlementsFor, isKnownPlan } from './plan-entitlements.js';

// Owner decision 2026-11-06: every known plan may create a locked room.
test('free and pro both allow locked rooms', () => {
  assert.deepEqual(entitlementsFor(PLAN.FREE), { canCreateLockedRoom: true });
  assert.deepEqual(entitlementsFor(PLAN.PRO), { canCreateLockedRoom: true });
  assert.equal(isKnownPlan('free'), true);
  assert.equal(isKnownPlan('pro'), true);
});

test('unknown plan has no entitlements', () => {
  for (const plan of ['enterprise', '', null, undefined, 'FREE', 'toString', '__proto__']) {
    assert.deepEqual(entitlementsFor(plan), { canCreateLockedRoom: false }, String(plan));
    assert.equal(isKnownPlan(plan), false, String(plan));
  }
});

test('entitlement results cannot alter the plan table', () => {
  const granted = entitlementsFor(PLAN.FREE);
  assert.throws(() => { granted.canCreateLockedRoom = false; }, TypeError);
  assert.equal(entitlementsFor(PLAN.FREE).canCreateLockedRoom, true);
});
