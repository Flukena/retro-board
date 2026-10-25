import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { timerSetupArguments } from '../../domain/vote-timing.js';

test('unlimited setup submits no deadline and no vote cap while preserving visibility flags', () => {
  assert.deepEqual(timerSetupArguments({ minutes: 3, votes: 3, noTimeLimit: true,
    unlimitedVotes: true, hideResults: true, showNonVoters: false }), [0, null, true, false]);
  assert.deepEqual(timerSetupArguments({ minutes: 5, votes: 10, noTimeLimit: false,
    unlimitedVotes: false, hideResults: false, showNonVoters: true }), [5, 10, false, true]);
});

test('timer setup keeps shortcut isolation, selected presets and labelled controls', async () => {
  await withChromeModule('/src/client/voting/TimerSetup.jsx', ({ TimerSetup }, { t }) => {
    const markup = renderToStaticMarkup(React.createElement(TimerSetup, { nestedZoneCount: 2, onClose() {} }));
    assert.match(markup, /data-board-shortcuts="off"/);
    assert.ok(markup.includes(`aria-label="${t('common.close')}"`));
    assert.match(markup, /aria-pressed="true"/);
    assert.match(markup, /rb-btn--primary rb-btn--block/);
    assert.ok(markup.includes(t('vote.session.coversNested', { n: 2 })));
  });
});

test('vote setup is a labelled dismissible dialog with one accessible close control', async () => {
  await withChromeModule('/src/client/voting/TimerSetup.jsx', ({ TimerSetup }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      const html = renderToStaticMarkup(React.createElement(TimerSetup, { onClose() {}, nestedZoneCount: 0 }));
      assert.match(html, /role="dialog"/);
      assert.match(html, /aria-modal="true"/);
      assert.match(html, /aria-labelledby="vote-dialog-title"/);
      assert.equal(html.split(`aria-label="${t('common.close')}"`).length - 1, 1);
    }
  });
});
