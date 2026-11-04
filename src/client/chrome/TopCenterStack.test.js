import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('TopCenterStack preserves presentation and event contracts', async () => {
  await withChromeModule('/src/client/chrome/TopCenterStack.jsx', async ({ TopCenterStack }) => {
    const markup = renderToStaticMarkup(React.createElement(TopCenterStack, {
      follow: { name: 'Alice', hue: 40, waiting: true },
      timers: [{ zoneId: 'z', title: 'Vote', label: '00:30', remainingMs: 30000 }],
    }));
    assert.ok(markup.indexOf('role="status"') < markup.indexOf('rb-timer-dock'));
    assert.match(markup, /Alice/);
    assert.match(markup, /aria-label=/);
  });
});

test('TopCenterStack renders nothing when all room results are dismissed', async () => {
  await withChromeModule('/src/client/chrome/TopCenterStack.jsx', ({ TopCenterStack }) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const key = JSON.stringify(['room', 'zone:1']);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => JSON.stringify([key]) } } });
    try {
      const board = { items: [{ id: 'zone', type: 'zone', voteResults: { resultId: 'zone:1' } }] };
      const html = renderToStaticMarkup(React.createElement(TopCenterStack, { board, roomHandle: 'room', timers: [] }));
      assert.equal(html, '');
      const follow = renderToStaticMarkup(React.createElement(TopCenterStack, {
        board, roomHandle: 'room', timers: [], follow: { name: 'Still following', hue: 40 },
      }));
      assert.match(follow, /Still following/);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else delete globalThis.window;
    }
  });
});

test('presenter banners: presenting offers Stop, an opted-out viewer can follow again', async () => {
  await withChromeModule('/src/client/chrome/TopCenterStack.jsx', ({ PresenterBanner, TopCenterStack }, { t }) => {
    const events = [];
    const presenting = PresenterBanner({ presenter: { kind: 'presenting', onAction: () => events.push('stop') } });
    assert.match(renderToStaticMarkup(presenting), new RegExp(t('presenter.stop')));
    const invite = PresenterBanner({ presenter: { kind: 'invite', name: 'Ada', onAction: () => events.push('rejoin') } });
    const inviteHtml = renderToStaticMarkup(invite);
    assert.match(inviteHtml, /Ada/);
    assert.match(inviteHtml, new RegExp(t('presenter.rejoin')));
    for (const tree of [presenting, invite]) React.Children.toArray(tree.props.children).at(-1).props.onClick();
    assert.deepEqual(events, ['stop', 'rejoin']);
    const stack = renderToStaticMarkup(React.createElement(TopCenterStack, { presenter: { kind: 'presenting', onAction: () => {} }, timers: [] }));
    assert.match(stack, /rb-top-center-stack/);
    const followingPresenter = renderToStaticMarkup(React.createElement(TopCenterStack, {
      follow: { name: 'Ada', hue: 1, waiting: false, presenter: true }, timers: [] }));
    assert.match(followingPresenter, new RegExp(t('presenter.following', { name: 'Ada' })));
  });
});

test('the meeting phase bar sits in the stack', async () => {
  await withChromeModule('/src/client/chrome/TopCenterStack.jsx', ({ TopCenterStack }, { t }) => {
    const bar = { steps: [{ id: 'vote', state: 'current' }], elapsedMinutes: 1, shortcut: null, canAdvance: false, isLast: false };
    const html = renderToStaticMarkup(React.createElement(TopCenterStack, { phase: { bar }, timers: [] }));
    assert.match(html, /rb-top-center-stack/);
    assert.match(html, new RegExp(t('phase.vote')));
  });
});

test('the mood banner and result card sit in the stack', async () => {
  await withChromeModule('/src/client/chrome/TopCenterStack.jsx', ({ TopCenterStack }, { t }) => {
    const banner = renderToStaticMarkup(React.createElement(TopCenterStack, { mood: { banner: { count: 1, answered: true, canClose: false } }, timers: [] }));
    assert.match(banner, new RegExp(t('mood.answered', { n: 1 })));
    const result = renderToStaticMarkup(React.createElement(TopCenterStack, {
      mood: { result: { count: 1, histogram: [0, 0, 0, 0, 1], average: 5 } }, timers: [] }));
    assert.match(result, new RegExp(t('mood.result')));
  });
});
