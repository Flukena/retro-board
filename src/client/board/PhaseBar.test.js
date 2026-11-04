import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const steps = ['write', 'reveal', 'group', 'vote', 'discuss', 'actions']
  .map((id, index) => ({ id, state: ['done', 'current'][index] ?? 'todo' }));

test('phase bar marks the current step and runs the admin shortcut and Next', async () => {
  await withChromeModule('/src/client/board/PhaseBar.jsx', ({ PhaseBar }, { t }) => {
    const events = [];
    const shortcut = { kind: 'reveal', zoneIds: ['a', 'b'] };
    const bar = { steps, elapsedMinutes: 4, shortcut, canAdvance: true, isLast: false };
    const tree = PhaseBar({ bar, onShortcut: (value) => events.push(value), onAdvance: () => events.push('next') });
    const html = renderToStaticMarkup(tree);
    assert.match(html, new RegExp(`aria-current="step"[^>]*>${t('phase.reveal')}<`));
    assert.match(html, new RegExp(t('phase.do.reveal', { n: 2 })));
    assert.match(html, new RegExp(t('phase.elapsed', { n: 4 })));
    const [, , shortcutButton, nextButton] = React.Children.toArray(tree.props.children);
    shortcutButton.type(shortcutButton.props).props.onClick();
    nextButton.props.onClick();
    assert.deepEqual(events, [shortcut, 'next']);
  });
});

test('viewers see the phase read-only; the last phase offers Finish', async () => {
  await withChromeModule('/src/client/board/PhaseBar.jsx', ({ PhaseBar }, { t }) => {
    const viewer = renderToStaticMarkup(PhaseBar({ bar: { steps, elapsedMinutes: 0, shortcut: null, canAdvance: false, isLast: false } }));
    assert.doesNotMatch(viewer, /<button/);
    const last = renderToStaticMarkup(PhaseBar({ bar: { steps, elapsedMinutes: 0, shortcut: null, canAdvance: true, isLast: true } }));
    assert.match(last, new RegExp(t('phase.finish')));
  });
});
