import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const childrenOf = (element) => React.Children.toArray(element.props.children);
const findAll = (element, match, found = []) => {
  if (!React.isValidElement(element)) return found;
  if (match(element)) found.push(element);
  React.Children.forEach(element.props.children, (child) => findAll(child, match, found));
  return found;
};

test('the dialog offers five scores and Skip', async () => {
  await withChromeModule('/src/client/board/MoodCheck.jsx', ({ MoodCheckDialog }, { t }) => {
    const events = [];
    const dialog = MoodCheckDialog({ onAnswer: (score) => events.push(score), onSkip: () => events.push('skip') });
    const choices = findAll(dialog, (node) => node.props.className === 'rb-mood-choice');
    assert.deepEqual(choices.map((choice) => choice.props.title), [1, 2, 3, 4, 5].map((score) => t(`mood.score.${score}`)));
    choices[3].props.onClick();
    findAll(dialog, (node) => node.props.children === t('mood.skip'))[0].props.onClick();
    assert.deepEqual(events, [4, 'skip']);
  });
});

test('the banner shows the count; Answer only for someone who has not answered, Close only for the admin', async () => {
  await withChromeModule('/src/client/board/MoodCheck.jsx', ({ MoodBanner }, { t }) => {
    const events = [];
    const banner = (state) => MoodBanner({ banner: state, onReopen: () => events.push('reopen'), onClose: () => events.push('close') });
    const waiting = banner({ count: 2, answered: false, canClose: true });
    assert.match(renderToStaticMarkup(waiting), new RegExp(t('mood.answered', { n: 2 })));
    childrenOf(waiting).slice(-2).forEach((button) => button.props.onClick());
    assert.deepEqual(events, ['reopen', 'close']);
    assert.doesNotMatch(renderToStaticMarkup(banner({ count: 3, answered: true, canClose: false })), /<button/);
  });
});

test('the result card lists every score with its count and the average, and can be dismissed', async () => {
  await withChromeModule('/src/client/board/MoodCheck.jsx', ({ MoodResultCard }, { t }) => {
    let dismissed = false;
    const card = MoodResultCard({ summary: { count: 3, histogram: [0, 1, 0, 2, 0], average: 3.3 }, onDismiss: () => { dismissed = true; } });
    const html = renderToStaticMarkup(card);
    assert.deepEqual([...html.matchAll(/rb-results__votes">(\d+)</g)].map((match) => Number(match[1])), [0, 1, 0, 2, 0]);
    assert.match(html, new RegExp(t('mood.average', { n: 3.3 })));
    assert.match(html, /--rb-result-share:1\b/);
    findAll(card, (node) => node.props.className?.includes('rb-results__close'))[0].props.onClick();
    assert.equal(dismissed, true);
  });
});
