import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE_SHORTCUT } from '../../domain/retro-phase.js';
import { PHASE_STEP_STATE, phaseBarModel } from './phase-bar-model.js';

const board = { items: [], allRevealed: false, editingLocked: true };
const MINUTE_MS = 60_000;

test('steps before the current phase are done and later ones are still to do', () => {
  const bar = phaseBarModel({ phase: { id: 'group', startedAt: 0 }, now: 3 * MINUTE_MS, board, isAdmin: false });
  assert.deepEqual(bar.steps.map((step) => step.state), [
    PHASE_STEP_STATE.DONE, PHASE_STEP_STATE.DONE, PHASE_STEP_STATE.CURRENT,
    PHASE_STEP_STATE.TODO, PHASE_STEP_STATE.TODO, PHASE_STEP_STATE.TODO,
  ]);
  assert.equal(bar.elapsedMinutes, 3);
  assert.equal(bar.isLast, false);
});

test('only the admin gets the shortcut and the Next control', () => {
  const phase = { id: 'write', startedAt: 0 };
  const viewer = phaseBarModel({ phase, now: 0, board, isAdmin: false });
  assert.equal(viewer.shortcut, null);
  assert.equal(viewer.canAdvance, false);
  const admin = phaseBarModel({ phase, now: 0, board, isAdmin: true });
  assert.deepEqual(admin.shortcut, { kind: PHASE_SHORTCUT.UNLOCK });
  assert.equal(admin.canAdvance, true);
});

test('the last phase finishes instead of advancing', () => {
  assert.equal(phaseBarModel({ phase: { id: 'actions', startedAt: 0 }, now: 0, board, isAdmin: true }).isLast, true);
});

test('the bar names the meeting zone and scopes the shortcut to it', () => {
  const zones = [
    { id: 'a', type: 'zone', x: 0, y: 0, w: 400, h: 400, title: 'Ideas', parentZoneId: null },
    { id: 'b', type: 'zone', x: 0, y: 600, w: 400, h: 400, title: '', parentZoneId: null },
  ];
  const scoped = { ...board, items: zones };
  const onB = phaseBarModel({ phase: { id: 'vote', startedAt: 0, zoneId: 'b' }, now: 0, board: scoped, isAdmin: true });
  assert.equal(onB.zoneTitle, '');
  assert.deepEqual(onB.shortcut, { kind: PHASE_SHORTCUT.VOTE, zoneId: 'b' });
  const whole = phaseBarModel({ phase: { id: 'vote', startedAt: 0, zoneId: null }, now: 0, board: scoped, isAdmin: true });
  assert.equal(whole.zoneTitle, null);
  assert.deepEqual(whole.shortcut, { kind: PHASE_SHORTCUT.VOTE, zoneId: 'a' });
});
