import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PHASE_SHORTCUT } from '../../domain/retro-phase.js';
import { useRetroPhase } from './use-retro-phase.js';

function renderPhase(props) {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  let api = null;
  function Probe() {
    api = useRetroPhase({
      mode: 'private', isAdmin: true, now: 0, board: { items: [], phase: null },
      patchMeta: record('patchMeta'), adminToggle: record('adminToggle'), fitToItems: record('fitToItems'),
      zoneActions: { toggleReveal: record('reveal'), vote: record('vote') }, showActionItems: record('actions'),
      ...props,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return { api, calls };
}

test('phase changes are silent writes that walk the phases and end', () => {
  const { api, calls } = renderPhase({ board: { items: [], phase: { id: 'discuss', startedAt: 0 } } });
  api.advance();
  api.end();
  assert.equal(calls[0][1].phase.id, 'actions');
  assert.deepEqual(calls[0][2], { silent: true });
  assert.deepEqual(calls[1], ['patchMeta', { phase: null }, { silent: true }]);
  const fresh = renderPhase({});
  fresh.api.start();
  assert.equal(fresh.calls[0][1].phase.id, 'write');
});

test('shortcuts call the existing board actions', () => {
  const { api, calls } = renderPhase({});
  api.runShortcut({ kind: PHASE_SHORTCUT.UNLOCK });
  api.runShortcut({ kind: PHASE_SHORTCUT.LOCK });
  api.runShortcut({ kind: PHASE_SHORTCUT.REVEAL, zoneIds: ['a', 'b'] });
  api.runShortcut({ kind: PHASE_SHORTCUT.VOTE, zoneId: 'z' });
  api.runShortcut({ kind: PHASE_SHORTCUT.ACTIONS });
  assert.deepEqual(calls, [
    ['adminToggle', 'editingLocked'], ['adminToggle', 'editingLocked'],
    ['reveal', 'a'], ['reveal', 'b'], ['fitToItems', ['z']], ['vote', 'z'], ['actions'],
  ]);
});

test('a public room shows no phase even if one was stored', () => {
  const { api } = renderPhase({ mode: 'public', board: { items: [], phase: { id: 'vote', startedAt: 0 } } });
  assert.equal(api.available, false);
  assert.equal(api.bar, null);
  assert.equal(api.running, false);
});
