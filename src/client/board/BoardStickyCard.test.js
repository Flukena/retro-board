import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const ITEM = { id: 'note', type: 'sticky', text: 'Private thought', authorId: 'owner', x: 0, y: 0 };
const noChange = () => {};
function context(overrides = {}) {
  return { selectedIds: new Set(), remoteSelectorsByItem: new Map(), focusedTextId: null, userId: 'viewer',
    stickyVotingContext: new Map(), allRevealed: false, denseRender: true, didUserVoteOn: () => false,
    voteCountOf: () => 2, voteFlashes: {}, topVotedRanks: new Map(), commentCountOf: () => 0,
    commentPreviewsByItem: new Map(), lang: 'en', startItemDrag: noChange, beginFocus: noChange,
    onTextChange: noChange, onTextKeyDown: noChange, onTextBlur: noChange, toggleVote: noChange,
    openComments: noChange, editAreaRef: { current: null }, ...overrides };
}
function inspect(Component, props) {
  let result;
  function Capture() { result = Component.type(props); return null; }
  renderToStaticMarkup(React.createElement(Capture)); return result.props;
}
test('the memo boundary forwards item ownership, remote presence, voting and handlers without viewport props', async () => {
  await withChromeModule('/src/client/board/BoardStickyCard.jsx', ({ BoardStickyCard }) => {
    const shared = context({ selectedIds: new Set(['note']), remoteSelectorsByItem: new Map([['note', { userId: 'peer' }]]),
      stickyVotingContext: new Map([['note', { revealed: true, votingAllowedNow: true, hideVoteCounts: true, inZone: true }]]),
      topVotedRanks: new Map([['note', 1]]), focusedTextId: 'note:text', userId: 'owner' });
    const props = inspect(BoardStickyCard, { item: ITEM, compact: true, context: shared });
    assert.equal(props.item, ITEM); assert.equal(props.compact, true); assert.equal(props.selected, false);
    assert.equal(props.remoteSelected, true); assert.equal(props.isEditing, true); assert.equal(props.isOwner, true);
    assert.equal(props.allRevealed, true); assert.equal(props.votingAllowedNow, true); assert.equal(props.showVoteCount, false);
    assert.equal(props.voteRank, 1); assert.equal(props.voteCount, 2); assert.equal(props.inZone, true);
    assert.equal(props.onStartDrag, shared.startItemDrag); assert.equal(props.onToggleVote, shared.toggleVote);
    assert.equal(props.editAreaRef, shared.editAreaRef); assert.equal(Object.hasOwn(props, 'zoom'), false);
  });
});
test('hidden text remains protected in both languages and updates when the viewer becomes its owner', async () => {
  await withChromeModule('/src/client/board/BoardStickyCard.jsx', ({ BoardStickyCard }, { getLang, setLang }) => {
    const previous = getLang();
    try {
      for (const lang of ['th', 'en']) {
        setLang(lang); const item = { ...ITEM, private: true };
        for (const userId of ['viewer', 'owner']) {
          const html = renderToStaticMarkup(React.createElement(BoardStickyCard, { item, compact: false, context: context({ lang, userId }) }));
          assert.equal(html.includes(ITEM.text), userId === 'owner');
        }
      }
    } finally { setLang(previous); }
  });
});
