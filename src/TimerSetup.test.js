import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { timerSetupArguments } from './vote-timing.js';

test('unlimited setup submits no deadline and no vote cap while preserving visibility flags', () => {
  assert.deepEqual(timerSetupArguments({ minutes: 3, votes: 3, noTimeLimit: true,
    unlimitedVotes: true, hideResults: true, showNonVoters: false }), [0, null, true, false]);
  assert.deepEqual(timerSetupArguments({ minutes: 5, votes: 10, noTimeLimit: false,
    unlimitedVotes: false, hideResults: false, showNonVoters: true }), [5, 10, false, true]);
});

test('timer setup keeps shortcut isolation, selected presets and labelled controls', async () => {
  await withChromeModule('/src/TimerSetup.jsx', ({ TimerSetup }, { t }) => {
    const markup = renderToStaticMarkup(React.createElement(TimerSetup, { nestedZoneCount: 2 }));
    assert.match(markup, /data-board-shortcuts="off"/);
    assert.ok(markup.includes(`aria-label="${t('common.close')}"`));
    assert.match(markup, /aria-pressed="true"/);
    assert.match(markup, /rb-btn--primary rb-btn--block/);
    assert.ok(markup.includes(t('vote.session.coversNested', { n: 2 })));
  });
});
