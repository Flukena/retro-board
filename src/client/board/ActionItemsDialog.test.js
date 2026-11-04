import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const ROW = Object.freeze({ id: 'a', hidden: false, text: 'Fix flaky CI', owner: 'Nok', due: '2026-11-03', done: false, createdAt: 1 });
const TODAY = '2026-11-04';

test('a row ticks done, marks overdue dates and locates its card', async () => {
  await withChromeModule('/src/client/board/ActionItemsDialog.jsx', ({ ActionItemRow }, { t }) => {
    const events = [];
    const tree = ActionItemRow({ row: ROW, can: true, today: TODAY,
      onPatch: (id, patch) => events.push(['patch', id, patch]), onLocate: id => events.push(['locate', id]) });
    const html = renderToStaticMarkup(tree);
    assert.match(html, /Fix flaky CI/);
    assert.match(html, /rb-action-row__due--overdue/);
    assert.match(html, new RegExp(t('action.markDone')));
    const [doneButton, , locateButton] = React.Children.toArray(tree.props.children);
    doneButton.props.onClick();
    locateButton.props.onClick();
    assert.deepEqual(events, [['patch', 'a', { actionDone: true }], ['locate', 'a']]);
  });
});

test('without edit rights the row cannot be ticked, and hidden cards show no text', async () => {
  await withChromeModule('/src/client/board/ActionItemsDialog.jsx', ({ ActionItemRow }, { t }) => {
    const events = [];
    const tree = ActionItemRow({ row: { ...ROW, hidden: true, text: '', owner: '' }, can: false, today: TODAY,
      onPatch: () => events.push('patch'), onLocate: () => {} });
    const html = renderToStaticMarkup(tree);
    assert.match(html, new RegExp(t('action.hiddenCard')));
    assert.doesNotMatch(html, /Fix flaky CI/);
    React.Children.toArray(tree.props.children)[0].props.onClick();
    assert.deepEqual(events, []);
  });
});

test('the dialog lists rows in th and en, and shows the empty state', async () => {
  await withChromeModule('/src/client/board/ActionItemsDialog.jsx', ({ ActionItemsDialog }, { t, getLang, setLang }) => {
    const previous = getLang();
    try {
      for (const lang of ['th', 'en']) {
        setLang(lang);
        const props = { canEdit: () => true, onPatch: () => {}, onLocate: () => {}, onClose: () => {} };
        const listed = renderToStaticMarkup(React.createElement(ActionItemsDialog, { ...props, rows: [ROW] }));
        assert.match(listed, new RegExp(t('action.title')));
        assert.match(listed, /Fix flaky CI/);
        const empty = renderToStaticMarkup(React.createElement(ActionItemsDialog, { ...props, rows: [] }));
        assert.match(empty, new RegExp(t('action.empty').slice(0, 10)));
      }
    } finally {
      setLang(previous);
    }
  });
});

test('the card badge appears only on action items and hides the owner on hidden cards', async () => {
  await withChromeModule('/src/client/board/ActionItemBadge.jsx', ({ ActionItemBadge }) => {
    const item = { id: 'a', type: 'sticky', actionItem: true, actionOwner: 'Nok', actionDue: '2026-11-30' };
    assert.match(renderToStaticMarkup(React.createElement(ActionItemBadge, { item, hidden: false })), /Nok/);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(ActionItemBadge, { item, hidden: true })), /Nok/);
    assert.equal(renderToStaticMarkup(React.createElement(ActionItemBadge, { item: { ...item, actionItem: false }, hidden: false })), '');
  });
});
