import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { buildVoteResults } from './vote-results.js';
import { TOKENS } from './theme.js';
import { contrastRatio } from './color-contrast.js';

const zone = { id: 'z', title: 'Retro', voteTimer: { startedAt: 10, endsAt: null, voteLimit: 2, showNonVoters: true } };
const sticky = { id: 's', type: 'sticky', private: true, authorId: 'owner', text: 'Private idea' };
const result = buildVoteResults(zone, [sticky], new Map([['s', new Set(['owner'])]]), [{ userId: 'owner', name: 'Owner' }], 100);

test('results show historical counts, accessible labels and viewer-specific titles in th/en', async () => {
  await withChromeModule('/src/VoteResultsCard.jsx', ({ VoteResultsCard }, { setLang, getLang, t }) => {
    const previous = getLang();
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        const props = { zone: { ...zone, voteResults: result }, board: { items: [sticky] }, now: 100 };
        const html = renderToStaticMarkup(React.createElement(VoteResultsCard, { ...props, userId: 'viewer' }));
        assert.match(html, /role="region"/);
        assert.ok(html.includes(t('vote.result.unavailable')));
        assert.ok(html.includes(t('vote.result.total', { n: 1 })));
        assert.ok(html.includes('1/2'));
        assert.doesNotMatch(html, /Private idea/);
        const owner = renderToStaticMarkup(React.createElement(VoteResultsCard, { ...props, userId: 'owner' }));
        assert.match(owner, /Private idea/);
      }
    } finally { setLang(previous); }
  });
});
test('result text and warning chips retain readable light/dark contrast', () => {
  for (const theme of Object.values(TOKENS)) {
    assert.ok(contrastRatio(theme['--text'], theme['--bg-panel']) >= 4.5);
    assert.ok(contrastRatio(theme['--warn-text'], theme['--warn-bg']) >= 4.5);
  }
});

test('polished results preserve empty, unlimited, incomplete and all-complete variants in both languages', async () => {
  await withChromeModule('/src/VoteResultsCard.jsx', ({ VoteResultsCard }, { t, setLang, getLang }) => {
    const previous = getLang();
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        const render = (snapshot) => renderToStaticMarkup(React.createElement(VoteResultsCard, {
          zone: { ...zone, color: 1, voteResults: snapshot }, board: { items: [sticky] }, now: 100,
        }));
        const empty = { ...result, voteLimit: null, totalVotes: 0, top: [], participants: [{ userId: 'owner', name: 'Owner', votes: 0 }] };
        const html = render(empty);
        assert.ok(html.includes(t('vote.result.empty')));
        assert.ok(html.includes(t('vote.result.notVoted')));
        assert.ok(html.includes(t('vote.result.noLimit')));
        assert.doesNotMatch(html, /rb-results__quota/);
        assert.match(html, /rb-results__trophy/);
        assert.match(html, /rb-results__stat/);
        const complete = render({ ...result, participants: [{ userId: 'owner', name: 'Owner', votes: 2 }] });
        assert.ok(complete.includes(t('vote.result.complete')));
        assert.match(complete, /rb-results__complete/);
        assert.doesNotMatch(complete, /rb-results__participants/);
        const ranked = render(result);
        assert.match(ranked, /--rb-result-share:1/);
        assert.match(ranked, /rb-results__track/);
      }
    } finally { setLang(previous); }
  });
});

test('success panel text retains readable contrast in light and dark themes', () => {
  for (const theme of Object.values(TOKENS)) {
    assert.ok(contrastRatio(theme['--results-success-text'], theme['--results-success-bg']) >= 4.5);
  }
});
