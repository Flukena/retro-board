import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_OWNER_MAX_LENGTH, isActionDueDate, normalizeActionFields } from './action-item.js';

test('due dates must be real calendar days in YYYY-MM-DD form', () => {
  assert.equal(isActionDueDate('2026-11-30'), true);
  assert.equal(isActionDueDate('2028-02-29'), true);
  assert.equal(isActionDueDate('2026-02-30'), false);
  assert.equal(isActionDueDate('2026-13-01'), false);
  assert.equal(isActionDueDate('30/11/2026'), false);
  assert.equal(isActionDueDate(20261130), false);
});

test('normalizeActionFields keeps valid fields and omits missing ones', () => {
  assert.deepEqual(normalizeActionFields({}, 'item a'), {});
  assert.deepEqual(
    normalizeActionFields({ actionItem: true, actionOwner: 'Nok', actionDue: '', actionDone: false }, 'item a'),
    { actionItem: true, actionOwner: 'Nok', actionDue: '', actionDone: false },
  );
});

test('normalizeActionFields rejects explicit invalid values instead of repairing them', () => {
  assert.throws(() => normalizeActionFields({ actionItem: 'yes' }, 'item a'), /actionItem must be a boolean/);
  assert.throws(() => normalizeActionFields({ actionDone: 1 }, 'item a'), /actionDone must be a boolean/);
  assert.throws(() => normalizeActionFields({ actionDue: '2026-02-30' }, 'item a'), /actionDue/);
  assert.throws(() => normalizeActionFields({ actionOwner: null }, 'item a'), /actionOwner must be a string/);
  assert.throws(
    () => normalizeActionFields({ actionOwner: 'x'.repeat(ACTION_OWNER_MAX_LENGTH + 1) }, 'item a'),
    /actionOwner is too long/,
  );
});
