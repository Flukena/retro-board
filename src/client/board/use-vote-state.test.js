import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from './use-vote-state.js';
import { createVoteFlashController } from './use-vote-state.js';
import { createVoteSnapshotController } from './use-vote-state.js';
import { createFakeClock } from '../../test-support/fake-clock.js';
import { activeVoteZone } from '../../domain/vote-ownership.js';
import { reuseSnapshotMap } from '../../domain/snapshot-references.js';

const NOW_MS = 1000;
function harness() {
  const card = { id: 'card', type: 'sticky', zoneId: 'zone', x: 20, y: 20, w: 10, h: 10 };
  const other = { ...card, id: 'other' };
  const zone = { id: 'zone', type: 'zone', x: 0, y: 0, w: 500, h: 500, voteTimer: { startedAt: 1, endsAt: null, voteLimit: 1 } };
  const boardRef = { current: { items: [zone, card, other] } };
  const votes = new Map(); const calls = [];
  const storage = {
    snapshotVotes() { assert.equal(this, storage); return votes; },
    setVote(id, user, enabled) { assert.equal(this, storage); calls.push(['vote', id, enabled]); votes.set(id, enabled ? new Set([user]) : new Set()); },
    deleteItemWithVotesAndComments(id) { assert.equal(this, storage); calls.push(['deleteTogether', id]); },
    clearVotesFor: id => calls.push(['clearVotes', id]), clearCommentsForItems: ids => calls.push(['clearComments', ids]),
    removeItem: id => calls.push(['remove', id]),
  };
  let selected = new Set(['card', 'other']);
  const focusedTextIdRef = { current: 'card:body' };
  const controller = createController({ boardRef, activeVoteZone, Date: { now: () => NOW_MS }, userId: 'me',
    window: { storage }, storage, setToast: value => calls.push(['toast', value]), t: key => key,
    flashVote: id => calls.push(['flash', id]), setBoard: update => { boardRef.current = update(boardRef.current); },
    setSelectedIds: update => { selected = update(selected); }, focusedTextIdRef, updateFocusedText: value => calls.push(['focus', value]),
  });
  return { controller, boardRef, card, other, zone, storage, votes, calls, selected: () => selected };
}

test('toggle reads each live snapshot so rapid clicks add then remove (INV-12)', () => {
  const h = harness(); h.controller.toggleVote(h.card); h.controller.toggleVote(h.card);
  assert.deepEqual(h.calls, [['vote', 'card', true], ['flash', 'card'], ['vote', 'card', false]]);
});

test('quota counts live votes only in active sessions; locked or absent sessions reject', () => {
  const h = harness(); h.votes.set('other', new Set(['me'])); h.controller.toggleVote(h.card);
  assert.deepEqual(h.calls, [['toast', { msg: 'vote.outOfQuota', type: 'warn' }]]);
  h.calls.length = 0; h.zone.votingLocked = true; h.controller.toggleVote(h.card);
  assert.equal(h.calls[0][1].msg, 'vote.notStarted');
  h.calls.length = 0; h.zone.votingLocked = false; h.zone.voteTimer = null; h.controller.toggleVote(h.card);
  assert.equal(h.calls[0][1].msg, 'vote.notStarted');
});

test('remove uses one combined item/vote/comment transaction, prunes local state and focus', () => {
  const h = harness(); h.controller.removeItemUnchecked('card');
  assert.deepEqual(h.calls, [['deleteTogether', 'card'], ['focus', null]]);
  assert.deepEqual(h.boardRef.current.items.map(item => item.id), ['zone', 'other']);
  assert.deepEqual(h.selected(), new Set(['other'])); h.controller.dispose();
});

test('older bridge fallback clears related state then removes item', () => {
  const h = harness(); delete h.storage.deleteItemWithVotesAndComments; h.controller.removeItemUnchecked('card');
  assert.deepEqual(h.calls, [['clearVotes', 'card'], ['clearComments', ['card']], ['remove', 'card'], ['focus', null]]);
});

test('flash expiry cannot clear a newer flash on the same card', () => {
  const clock = createFakeClock(NOW_MS); let state = {};
  const controller = createVoteFlashController({ clock, publish: update => { state = update(state); } });
  controller.flash('card'); clock.advance(100); controller.flash('card');
  clock.advance(800); assert.deepEqual(state, { card: 1100 });
  clock.advance(100); assert.deepEqual(state, {});
});

test('vote/comment channels refresh, preserve equal snapshot identity and unsubscribe both', () => {
  let votes = new Map(); let comments = new Map(); const listeners = new Map();
  const voters = new Set(['me']);
  const storage = {
    snapshotVotes() { assert.equal(this, storage); return new Map([['card', voters]]); },
    snapshotComments() { assert.equal(this, storage); return new Map([['card', [{ id: 'comment', text: 'hello' }]]]); },
    onVotesChange: handler => listeners.set('votes', handler), onCommentsChange: handler => listeners.set('comments', handler),
    offVotesChange: handler => { assert.equal(listeners.get('votes'), handler); listeners.delete('votes'); },
    offCommentsChange: handler => { assert.equal(listeners.get('comments'), handler); listeners.delete('comments'); },
  };
  const controller = createVoteSnapshotController({ window: { storage }, reuseSnapshotMap,
    setVotesByItem: update => { votes = update(votes); }, setCommentsByItem: update => { comments = update(comments); },
  });
  controller.refreshVotes(); controller.refreshComments(); const previous = votes;
  controller.subscribe(); listeners.get('votes')(); listeners.get('comments')();
  assert.equal(votes, previous); assert.deepEqual(votes.get('card'), new Set(['me']));
  assert.equal(comments.get('card')[0].text, 'hello'); controller.dispose(); assert.equal(listeners.size, 0);
});

test('flash dispose cancels every pending timer without later state writes', () => {
  const clock = createFakeClock(NOW_MS); let writes = 0;
  const controller = createVoteFlashController({ clock, publish: () => { writes++; } });
  controller.flash('a'); controller.flash('b'); assert.equal(clock.pendingCount(), 2);
  controller.dispose(); assert.equal(clock.pendingCount(), 0);
  clock.advance(1000); assert.equal(writes, 2);
});

test('default flash timers preserve native host receivers for scheduling and disposal', () => {
  const originalSetTimeout = globalThis.setTimeout; const originalClearTimeout = globalThis.clearTimeout;
  const calls = [];
  try {
    globalThis.setTimeout = function (run, delayMs) { assert.equal(this, globalThis); assert.equal(typeof run, 'function'); calls.push(['schedule', delayMs]); return 42; };
    globalThis.clearTimeout = function (id) { assert.equal(this, globalThis); calls.push(['cancel', id]); };
    const controller = createVoteFlashController({ publish: () => {} });
    controller.flash('card'); controller.dispose();
    assert.deepEqual(calls, [['schedule', 900], ['cancel', 42]]);
  } finally {
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
  }
});

test('votes on expired sessions do not consume the new session quota', () => {
  const h = harness();
  const oldZone = { ...h.zone, id: 'oldZone', x: 1000, voteTimer: { startedAt: 1, endsAt: 500 } };
  const oldCard = { ...h.card, id: 'oldCard', zoneId: 'oldZone', x: 1020 };
  h.boardRef.current.items.push(oldZone, oldCard); h.votes.set('oldCard', new Set(['me']));
  h.controller.toggleVote(h.card); assert.deepEqual(h.calls, [['vote', 'card', true], ['flash', 'card']]);
});
