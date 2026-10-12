import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { buildTopVotedRanks } from './voting-results.js';
import { BOARD_TEXT_MAX_LENGTH } from './security-boundaries.js';
import { DEFAULT_STICKY_HEIGHT_PX } from './board-geometry.js';

const ITEM = { id: 'sticky-a', type: 'sticky', text: 'A useful idea', authorName: 'Ada', color: 0, x: 10, y: 20, rotation: 3 };
const COMMENT_COUNT = 7;
const NO_OVERFLOW_METRICS = { scrollHeight: DEFAULT_STICKY_HEIGHT_PX, clientHeight: DEFAULT_STICKY_HEIGHT_PX };

function renderCard(StickyCard, props = {}) {
  let tree;
  function InspectCard() {
    tree = StickyCard.type({ item: ITEM, commentPreviews: [], commentCount: 0, ...props });
    return tree;
  }
  const html = renderToStaticMarkup(React.createElement(InspectCard));
  return { tree, html };
}

function findElement(tree, predicate) {
  if (!React.isValidElement(tree)) return undefined;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function byClass(tree, className) {
  return findElement(tree, (node) => node.props.className?.split(' ').includes(className));
}

test('text and private visibility follow owner/reveal props in th/en', async () => {
  await withChromeModule('/src/StickyCard.jsx', ({ StickyCard }, { t, getLang, setLang }) => {
    const previous = getLang();
    try {
      for (const lang of ['th', 'en']) {
        setLang(lang);
        for (const [isOwner, allRevealed] of [[false, false], [true, false], [false, true]]) {
          const { tree, html } = renderCard(StickyCard, {
            item: { ...ITEM, private: true }, isOwner, allRevealed, lang,
          });
          const hidden = !isOwner && !allRevealed;
          assert.equal(html.includes(ITEM.text), !hidden);
          assert.equal(Boolean(byClass(tree, 'rb-sticky__hidden')), hidden);
          if (hidden) {
            assert.equal(byClass(tree, 'rb-sticky__hidden-title').props.children, t('sticky.hidden'));
            assert.equal(byClass(tree, 'rb-sticky__hidden-author').props.children,
              t('sticky.hiddenBy', { name: ITEM.authorName }));
            assert.equal(byClass(tree, 'rb-sticky__vote-pill').props.disabled, true);
          }
        }
      }
    } finally { setLang(previous); }
  });
});

test('voting permits removal of an existing vote after voting closes, in full and overview modes', async () => {
  await withChromeModule('/src/StickyCard.jsx', ({ StickyCard }) => {
    for (const compact of [false, true]) {
      for (const votingAllowedNow of [false, true]) {
        for (const voted of [false, true]) {
          const { tree } = renderCard(StickyCard, { compact, votingAllowedNow, voted, showVoteCount: true, voteCount: 1 });
          const className = compact ? 'rb-card-overview__vote' : 'rb-sticky__vote-pill';
          const button = byClass(tree, className);
          assert.equal(button.props.disabled, !votingAllowedNow && !voted);
          assert.equal(button.props.className.split(' ').includes(className + '--voted'), voted);
        }
      }
    }
  });
});

test('only the top three scored cards receive localized medals from the ranking contract', async () => {
  await withChromeModule('/src/StickyCard.jsx', ({ StickyCard }, { t, getLang, setLang }) => {
    const root = { id: 'zone-a', type: 'zone', lastResultsAt: 1 };
    const cards = ['first', 'second', 'third', 'fourth'].map((id) => ({ ...ITEM, id }));
    const counts = new Map(cards.map((card, index) => [card.id, cards.length - index]));
    const ranks = buildTopVotedRanks({ items: [root, ...cards], voteCountOf: (id) => counts.get(id),
      groupIdsForZone: () => [root.id], ownerZoneForItem: () => root, zoneHasActiveGovernor: () => false });
    const previous = getLang();
    try {
      for (const lang of ['th', 'en']) {
        setLang(lang);
        for (const [index, item] of cards.entries()) {
          const { tree, html } = renderCard(StickyCard, { item, voteRank: ranks.get(item.id), lang });
          const medal = byClass(tree, 'rb-winner-medal');
          const expectedRank = index + 1;
          assert.equal(Boolean(medal), expectedRank <= 3);
          if (medal) {
            assert.equal(medal.props.children, expectedRank);
            assert.equal(medal.props['aria-label'], t('vote.rank', { n: expectedRank }));
            assert.ok(html.includes('role="img"'));
          }
        }
        assert.equal(byClass(renderCard(StickyCard, { voteRank: null }).tree, 'rb-winner-medal'), undefined);
      }
    } finally { setLang(previous); }
  });
});

test('comment count and private owner lock remain visible according to their props', async () => {
  await withChromeModule('/src/StickyCard.jsx', ({ StickyCard }, { t }) => {
    const { tree, html } = renderCard(StickyCard, { commentCount: COMMENT_COUNT, item: { ...ITEM, private: true }, isOwner: true });
    const chip = byClass(tree, 'rb-sticky__comment-chip');
    assert.equal(chip.props.title, t('comments.tooltip'));
    assert.equal(byClass(tree, 'rb-sticky__comment-count').props.children, COMMENT_COUNT);
    assert.ok(html.includes(String(COMMENT_COUNT)));
    assert.ok(byClass(tree, 'rb-sticky__lock'));
    assert.equal(byClass(renderCard(StickyCard, { commentCount: 0 }).tree, 'rb-sticky__comment-chip'), undefined);
    assert.equal(byClass(renderCard(StickyCard, { item: { ...ITEM, locked: true } }).tree, 'rb-sticky__lock'), undefined);
  });
});

test('editing injects the editor and forwards value, keyboard, blur and overflow events', async () => {
  await withChromeModule('/src/StickyCard.jsx', ({ StickyCard }, { t }) => {
    const events = [];
    const editorRef = { current: null };
    function Editor({ value, className }) {
      return React.createElement('textarea', { value, className, readOnly: true });
    }
    const { tree, html } = renderCard(StickyCard, { isEditing: true, TextEditor: Editor, editAreaRef: editorRef,
      onTextChange: (...args) => events.push(args), onTextKeyDown: (...args) => events.push(args),
      onTextBlur: (...args) => events.push(args) });
    const editor = findElement(tree, (node) => node.type === Editor);
    assert.ok(html.includes('<textarea'));
    assert.equal(editor.props.editorRef, editorRef);
    assert.equal(editor.props.value, ITEM.text);
    assert.equal(editor.props.maxLength, BOARD_TEXT_MAX_LENGTH);
    assert.equal(editor.props.placeholder, t('sticky.placeholder'));
    editor.props.onValueChange('Updated idea', NO_OVERFLOW_METRICS);
    const keyEvent = { key: 'Enter' };
    editor.props.onKeyDown(keyEvent);
    editor.props.onBlur();
    assert.deepEqual(events, [[ITEM.id, { text: 'Updated idea' }], [keyEvent], [ITEM.id]]);
    events.length = 0;
    const overflowPx = 20;
    editor.props.onContentOverflow(overflowPx);
    assert.deepEqual(events, [[ITEM.id, { h: DEFAULT_STICKY_HEIGHT_PX + overflowPx }, { silent: true }]]);
    let stopped = false;
    editor.props.onMouseDown({ stopPropagation: () => { stopped = true; } });
    assert.ok(stopped);
  });
});
