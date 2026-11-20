import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoteFinalizationController } from './vote-finalization-controller.js';

const NOW_MS = 1000;
function harness(plan = { entries: [{ id: 'card', patch: { x: 80 } }, { id: 'zone', patch: { voteTimer: null } }] }) {
  const zone = { id: 'zone', type: 'zone', x: 0, y: 0, w: 500, h: 500, voteTimer: { startedAt: 10 } };
  const card = { id: 'card', type: 'sticky', x: 20, y: 20, w: 10, h: 10 };
  const outside = { ...card, id: 'outside', x: 1000 };
  const boardRef = { current: { items: [zone, card, outside] } };
  const moves = new Set(['zone', 'card', 'outside']); const calls = [];
  const recentMoves = { forget: ids => { calls.push(['forget', ids]); ids.forEach(id => moves.delete(id)); } };
  const participants = ['me'];
  const storage = {
    getVoteResultParticipants() { assert.equal(this, storage); calls.push(['participants']); return participants; },
    finalizeVoteSession(...args) { assert.equal(this, storage); calls.push(['finalize', ...args]); return plan; },
  };
  const controller = createVoteFinalizationController({ boardRef, recentMoves,
    view: { storage }, clock: { now: () => NOW_MS },
    setBoard: update => { calls.push(['board']); boardRef.current = update(boardRef.current); },
  });
  return { controller, boardRef, moves, calls, outside, zone };
}

test('vote finalization forgets only its scope before committing and applies one optimistic plan', () => {
  const h = harness(); h.controller.finalizeVotingSession('zone');
  assert.deepEqual(h.calls, [['forget', ['zone', 'card']], ['participants'], ['finalize', 'zone', 10, ['me'], NOW_MS], ['board']]);
  assert.deepEqual(h.moves, new Set(['outside']));
  assert.equal(h.boardRef.current.items[0].voteTimer, null); assert.equal(h.boardRef.current.items[1].x, 80);
  assert.equal(h.boardRef.current.items[2], h.outside);
});

test('missing or ended session is inert; rejected plan preserves the board after forgetting scope', () => {
  const h = harness(null); const previous = h.boardRef.current;
  h.controller.finalizeVotingSession('missing'); assert.deepEqual(h.calls, []);
  h.controller.finalizeVotingSession('zone'); assert.equal(h.boardRef.current, previous);
  assert.equal(h.calls.at(-1)[0], 'finalize'); assert.deepEqual(h.moves, new Set(['outside']));
  h.calls.length = 0; h.zone.voteTimer = null; h.controller.finalizeVotingSession('zone'); assert.deepEqual(h.calls, []);
});
