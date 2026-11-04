import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_OWNER_MAX_LENGTH,
  actionItemsOf,
  actionTogglePatch,
  isActionDueDate,
  isActionItem,
  normalizeActionFields,
  openActionCount,
} from './action-item.js';

const sticky = (id, fields = {}) => ({ id, type: 'sticky', x: 0, y: 0, text: `card ${id}`, authorId: 'author', createdAt: 1, ...fields });
const VIEWER = { userId: 'viewer', allRevealed: false };

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

test('only stickies flagged true are action items, and the toggle flips the flag', () => {
  assert.equal(isActionItem(sticky('a', { actionItem: true })), true);
  assert.equal(isActionItem(sticky('a', { actionItem: false })), false);
  assert.equal(isActionItem({ id: 'z', type: 'zone', actionItem: true }), false);
  assert.deepEqual(actionTogglePatch(sticky('a')), { actionItem: true });
  assert.deepEqual(actionTogglePatch(sticky('a', { actionItem: true })), { actionItem: false });
});

test('rows list open items first, dated before undated, earliest due first', () => {
  const items = [
    sticky('done', { actionItem: true, actionDone: true, actionDue: '2026-01-01' }),
    sticky('undated', { actionItem: true }),
    sticky('late', { actionItem: true, actionDue: '2026-12-01' }),
    sticky('soon', { actionItem: true, actionDue: '2026-11-10' }),
    sticky('plain'),
  ];
  const rows = actionItemsOf(items, VIEWER);
  assert.deepEqual(rows.map(row => row.id), ['soon', 'late', 'undated', 'done']);
  assert.equal(openActionCount(rows), 3);
});

test('a private card hidden from the viewer keeps status but not text or owner', () => {
  const items = [sticky('secret', { actionItem: true, private: true, actionOwner: 'Nok', actionDue: '2026-11-10' })];
  const [row] = actionItemsOf(items, VIEWER);
  assert.equal(row.hidden, true);
  assert.equal(row.text, '');
  assert.equal(row.owner, '');
  assert.equal(row.due, '2026-11-10');
  const [authorRow] = actionItemsOf(items, { userId: 'author', allRevealed: false });
  assert.equal(authorRow.text, 'card secret');
  assert.equal(authorRow.owner, 'Nok');
});
