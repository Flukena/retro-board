import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminActions } from './use-admin-actions.js';
import { DEFAULT_BOARD } from '../../domain/board-state.js';
import { CLEARED_VOTE_RESULTS } from '../../domain/vote-session-lifecycle.js';

const NOW_MS = 1000;
const RESET_FIELDS = ['items', 'timer', 'lastResultsAt', 'allRevealed', 'votingLocked', 'editingLocked', 'phase', 'moodCheck'];
const PRESERVED_FIELDS = ['adminUserId', 'title', 'adminPinHash', 'presenterUserId'];
function assertClearDecisions(defaults) {
  assert.deepEqual(Object.keys(defaults).sort(), [...RESET_FIELDS, ...PRESERVED_FIELDS].sort(), 'each DEFAULT_BOARD field needs an explicit clear decision');
}
function harness(overrides = {}) {
  const calls = []; const zone = { id: 'zone', type: 'zone', x: 0, y: 0, w: 500, h: 500, locked: true };
  const card = { id: 'card', type: 'sticky', x: 20, y: 20, w: 10, h: 10, private: true };
  const boardRef = { current: { ...DEFAULT_BOARD, items: [zone, card], adminUserId: 'admin', adminPinHash: 'hash', title: 'room', presenterUserId: 'presenter',
    phase: { id: 'vote' }, moodCheck: { id: 'round', open: true }, allRevealed: true, editingLocked: true, votingLocked: true, timer: {}, lastResultsAt: 99 } };
  const storage = {
    clearAllVotes() { assert.equal(this, storage); calls.push(['votes']); },
    clearAllComments() { assert.equal(this, storage); calls.push(['comments']); },
    startVoteSession(...args) { assert.equal(this, storage); calls.push(['session', ...args]); return true; },
    updateItems: entries => { calls.push(['update', entries]); return true; },
  };
  const options = { isAdmin: true, setToast: value => calls.push(['toast', value]), t: (key, args) => ({ key, ...args }),
    boardRef, clock: { now: () => NOW_MS }, view: { storage }, storage,
    patchMeta: patch => calls.push(['meta', patch]), reportWriteFailure: () => calls.push(['failure']),
    setBoard: update => { boardRef.current = update(boardRef.current); }, setTimerSetupZoneId: value => calls.push(['setup', value]),
    updateItem: (...args) => calls.push(['item', ...args]), finalizeVotingSession: id => calls.push(['finalize', id]),
    replaceBoardLocal: board => { calls.push(['replace', board]); return true; }, setConfirmClear: value => calls.push(['clearConfirm', value]),
    setConfirmResetVotes: value => calls.push(['resetConfirm', value]), setConfirmUnlockAll: value => calls.push(['unlockConfirm', value]), ...overrides };
  return { controller: createAdminActions(options), boardRef, zone, storage, calls };
}

test('clear makes named phase/mood decisions and explicitly classifies every default field (INV-14)', () => {
  assertClearDecisions(DEFAULT_BOARD);
  assert.throws(() => assertClearDecisions({ ...DEFAULT_BOARD, futureField: null }), assert.AssertionError);
  const h = harness(); h.controller.adminClearBoard();
  assert.deepEqual(h.calls.map(call => call[0]), ['votes', 'comments', 'replace', 'clearConfirm']);
  const next = h.calls[2][1];
  for (const key of RESET_FIELDS) {
    assert.notDeepEqual(h.boardRef.current[key], DEFAULT_BOARD[key], `${key} fixture must be dirty`);
    assert.deepEqual(next[key], DEFAULT_BOARD[key], `${key} must clear`);
  }
  for (const key of PRESERVED_FIELDS) assert.equal(next[key], h.boardRef.current[key]);
  assert.deepEqual(Object.keys(next).sort(), Object.keys(h.boardRef.current).sort(), "clear adds or drops no board field");
});

test('failed clear keeps its confirmation; non-admin actions cannot write', () => {
  const failed = harness({ replaceBoardLocal: () => false }); failed.controller.adminClearBoard();
  assert.deepEqual(failed.calls, [['votes'], ['comments']]);
  const denied = harness({ isAdmin: false });
  denied.controller.adminStartTimer('zone', 2, 3); denied.controller.adminClearBoard(); denied.controller.adminResetVotes();
  denied.controller.adminUnlockAll(); denied.controller.adminExtendTimer('zone', 1); denied.controller.adminStopTimer('zone');
  assert.deepEqual(denied.calls, []); denied.controller.adminToggle('editingLocked');
  assert.equal(denied.calls[0][1].msg.key, 'common.adminOnly');
});

test('start session commits the complete scope before optimistic timer state and setup dismissal', () => {
  const h = harness(); h.controller.adminStartTimer('zone', 2, 3, true, false);
  const expectedTimer = { startedAt: NOW_MS, endsAt: 121000, voteLimit: 3, hideResults: true, showNonVoters: false };
  assert.deepEqual(h.calls[0], ['session', 'zone', { voteTimer: expectedTimer, ...CLEARED_VOTE_RESULTS, votingLocked: false }, [], ['card']]);
  assert.deepEqual(h.boardRef.current.items[0].voteTimer, expectedTimer);
  assert.deepEqual(h.calls[1], ['setup', null]); assert.equal(h.calls[2][1].msg.key, 'vote.session.started');
});

test('related sessions, missing zone, false/throwing writes prevent optimistic starts', () => {
  for (const throwing of [false, true]) {
    const h = harness(); h.storage.startVoteSession = () => { if (throwing) throw new Error('write'); return false; };
    h.controller.adminStartTimer('zone', 1); assert.deepEqual(h.calls, [['failure']]); assert.equal(h.zone.voteTimer, undefined);
  }
  const h = harness(); h.zone.voteTimer = { startedAt: 1, endsAt: null }; h.controller.adminStartTimer('zone', 1);
  assert.equal(h.calls[0][1].msg.key, 'vote.session.relatedActive'); h.calls.length = 0;
  h.controller.adminStartTimer('missing', 1); assert.deepEqual(h.calls, []);
});

test('extend/stop/toggle use current zone and board values', () => {
  const h = harness(); h.zone.voteTimer = { startedAt: 1, endsAt: 3000 };
  h.controller.adminExtendTimer('zone', 1); h.controller.adminStopTimer('zone'); h.controller.adminToggle('editingLocked');
  assert.deepEqual(h.calls, [['item', 'zone', { voteTimer: { startedAt: 1, endsAt: 63000 } }], ['finalize', 'zone'], ['meta', { editingLocked: false }]]);
});

test('unlock/reset failures stop before meta, confirmation and success notice', () => {
  for (const action of ['adminUnlockAll', 'adminResetVotes']) {
    const h = harness(); h.zone.voteTimer = { startedAt: 1 }; h.storage.updateItems = () => false;
    h.controller[action](); assert.equal(h.calls.at(-1)[0], 'failure');
    assert.ok(h.calls.every(call => !['meta', 'unlockConfirm', 'resetConfirm', 'toast'].includes(call[0])));
  }
});

test('unlock and reset commit zone patches and close confirmation only after success', () => {
  const h = harness(); h.controller.adminUnlockAll();
  assert.equal(h.boardRef.current.items[0].locked, false); assert.equal(h.boardRef.current.items[1].private, false);
  assert.deepEqual(h.calls.slice(-3), [['meta', { editingLocked: false }], ['unlockConfirm', false], ['toast', { msg: { key: 'unlockAll.done' }, type: 'info' }]]);
  h.calls.length = 0; h.zone.voteTimer = { startedAt: 1 }; h.boardRef.current.items[0].voteTimer = h.zone.voteTimer;
  h.controller.adminResetVotes(); assert.equal(h.boardRef.current.items[0].voteTimer, null);
  assert.deepEqual(h.calls.slice(-3), [['meta', { lastResultsAt: null }], ['resetConfirm', false], ['toast', { msg: { key: 'reset.done' }, type: 'info' }]]);
});
