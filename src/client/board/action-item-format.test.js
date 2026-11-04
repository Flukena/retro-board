import test from 'node:test';
import assert from 'node:assert/strict';
import { formatActionDue, isActionOverdue, localIsoDate } from './action-item-format.js';

test('due dates render as a short day and month in the chosen language', () => {
  assert.equal(formatActionDue('2026-11-30', 'en'), 'Nov 30');
  assert.match(formatActionDue('2026-11-30', 'th'), /^30 /);
  assert.equal(formatActionDue('', 'en'), '');
  assert.equal(formatActionDue('2026-02-30', 'en'), '');
});

test('only open items with a due day before today are overdue', () => {
  const today = '2026-11-04';
  assert.equal(isActionOverdue({ done: false, due: '2026-11-03' }, today), true);
  assert.equal(isActionOverdue({ done: false, due: '2026-11-04' }, today), false);
  assert.equal(isActionOverdue({ done: true, due: '2026-11-03' }, today), false);
  assert.equal(isActionOverdue({ done: false, due: '' }, today), false);
});

test('localIsoDate uses the local calendar day', () => {
  const date = new Date(2026, 10, 4, 23, 30);
  assert.equal(localIsoDate(date), '2026-11-04');
});
