import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_SHORTCUT, RETRO_PHASES, isPhaseState, nextPhaseId, phaseElapsedMinutes, phaseShortcut, phaseZone,
  phaseZoneChoices, phasesAvailable,
} from './retro-phase.js';

const zone = (id, x, y, extra = {}) => ({ id, type: 'zone', x, y, w: 400, h: 400, parentZoneId: null, ...extra });
const board = (items, extra = {}) => ({ items, allRevealed: false, editingLocked: false, ...extra });

test('phases run write → reveal → group → vote → discuss → actions, then end', () => {
  assert.deepEqual(RETRO_PHASES, ['write', 'reveal', 'group', 'vote', 'discuss', 'actions']);
  const visited = [];
  for (let id = nextPhaseId(null); id; id = nextPhaseId(id)) visited.push(id);
  assert.deepEqual(visited, RETRO_PHASES);
  assert.equal(nextPhaseId('actions'), null);
  assert.equal(nextPhaseId('unknown'), null);
});

test('the phase validator accepts null or a known id with a start time', () => {
  assert.equal(isPhaseState(null), true);
  assert.equal(isPhaseState({ id: 'vote', startedAt: 5 }), true);
  for (const bad of [undefined, 'vote', [], { id: 'party', startedAt: 5 }, { id: 'vote' },
    { id: 'vote', startedAt: -1 }, { id: 'vote', startedAt: Infinity }]) {
    assert.equal(isPhaseState(bad), false, JSON.stringify(bad));
  }
});

test('reveal suggests only hidden top-level zones, top to bottom', () => {
  const outer = zone('outer', 0, 500);
  const inner = zone('inner', 10, 510, { w: 100, h: 100, parentZoneId: 'outer' });
  const shown = zone('shown', 600, 0, { revealed: true });
  const first = zone('first', 0, 0);
  const shortcut = phaseShortcut('reveal', board([outer, inner, shown, first]));
  assert.deepEqual(shortcut, { kind: PHASE_SHORTCUT.REVEAL, zoneIds: ['first', 'outer'] });
  assert.equal(phaseShortcut('reveal', board([outer], { allRevealed: true })), null);
});

test('vote suggests the first top-level zone without a running vote', () => {
  const busy = zone('busy', 0, 0, { voteTimer: { startedAt: 1 } });
  const next = zone('next', 0, 600);
  assert.deepEqual(phaseShortcut('vote', board([next, busy])), { kind: PHASE_SHORTCUT.VOTE, zoneId: 'next' });
  assert.equal(phaseShortcut('vote', board([busy])), null);
});

test('write unlocks and discuss locks editing, only when needed', () => {
  assert.deepEqual(phaseShortcut('write', board([], { editingLocked: true })), { kind: PHASE_SHORTCUT.UNLOCK });
  assert.equal(phaseShortcut('write', board([])), null);
  assert.deepEqual(phaseShortcut('discuss', board([])), { kind: PHASE_SHORTCUT.LOCK });
  assert.equal(phaseShortcut('discuss', board([], { editingLocked: true })), null);
  assert.deepEqual(phaseShortcut('actions', board([])), { kind: PHASE_SHORTCUT.ACTIONS });
  assert.equal(phaseShortcut('group', board([zone('z', 0, 0)])), null);
});

test('elapsed minutes round down and never go negative', () => {
  assert.equal(phaseElapsedMinutes({ startedAt: 0 }, 179_999), 2);
  assert.equal(phaseElapsedMinutes({ startedAt: 1000 }, 0), 0);
});

test('phases are not offered on public boards', () => {
  assert.equal(phasesAvailable('public'), false);
  assert.equal(phasesAvailable('private'), true);
});

test('the phase may name a safe zone id, or none for the whole board', () => {
  assert.equal(isPhaseState({ id: 'vote', startedAt: 5, zoneId: 'zone-1' }), true);
  assert.equal(isPhaseState({ id: 'vote', startedAt: 5, zoneId: null }), true);
  assert.equal(isPhaseState({ id: 'vote', startedAt: 5, zoneId: 'bad id' }), false);
  assert.equal(isPhaseState({ id: 'vote', startedAt: 5, zoneId: 7 }), false);
});

test('zone choices are top-level zones, top to bottom, with the cards inside each', () => {
  const outer = zone('outer', 0, 500, { title: 'Went well' });
  const inner = zone('inner', 10, 510, { w: 100, h: 100, parentZoneId: 'outer' });
  const first = zone('first', 0, 0, { title: 'Ideas' });
  const card = (id, parentZoneId) => ({ id, type: 'sticky', x: 20, y: 520, w: 50, h: 50, parentZoneId });
  const items = [outer, inner, first, card('s1', 'outer'), card('s2', 'inner')];
  assert.deepEqual(phaseZoneChoices(items), [
    { id: 'first', title: 'Ideas', cardCount: 0 }, { id: 'outer', title: 'Went well', cardCount: 2 },
  ]);
  assert.equal(phaseZone({ zoneId: 'outer' }, items), outer);
  assert.equal(phaseZone({ zoneId: 'inner' }, items), null, 'a nested zone is not a meeting zone');
  assert.equal(phaseZone({ zoneId: 'gone' }, items), null);
  assert.equal(phaseZone({ zoneId: null }, items), null);
});

test('with a meeting zone, reveal and vote act on that zone only', () => {
  const picked = zone('picked', 0, 600);
  const other = zone('other', 0, 0);
  const items = board([other, picked]);
  assert.deepEqual(phaseShortcut('reveal', items, picked), { kind: PHASE_SHORTCUT.REVEAL, zoneIds: ['picked'] });
  assert.deepEqual(phaseShortcut('vote', items, picked), { kind: PHASE_SHORTCUT.VOTE, zoneId: 'picked' });
  assert.equal(phaseShortcut('reveal', items, { ...picked, revealed: true }), null);
  assert.equal(phaseShortcut('vote', items, { ...picked, voteTimer: { startedAt: 1 } }), null);
});
