import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('selection toolbar exposes only the controls allowed for its type and role', async () => {
  await withChromeModule('/src/SelectionToolbar.jsx', ({ SelectionToolbar }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const render = (type, isAdmin = false) => renderToStaticMarkup(React.createElement(SelectionToolbar, {
        anchor: { x: 100, y: 200 }, item: { type }, can: true, canDelete: false, isAdmin,
      }));
      const zone = render('zone');
      assert.match(zone, new RegExp(t('zone.exportCsvTitle')));
      assert.ok(!zone.includes(t('zone.startVote')));
      assert.ok(!zone.includes(t('zone.revealCards')));
      const admin = render('zone', true);
      assert.ok(admin.includes(t('zone.startVote')));
      assert.ok(admin.includes(t('zone.revealCards')));
      for (const type of ['sticky', 'text', 'image']) {
        const markup = render(type, true);
        assert.ok(!markup.includes(t('zone.exportCsvTitle')));
        assert.ok(!markup.includes(t('zone.startVote')));
        assert.ok(!markup.includes(t('zone.revealCards')));
        assert.ok(markup.includes(`title="${t('selection.bringToFront')}"`));
        assert.ok(markup.includes(`title="${t('selection.sendToBack')}"`));
        assert.match(markup, /class="rb-icon-btn rb-icon-btn--danger"[^>]*disabled=""/);
      }
      for (const name of ['yellow', 'red', 'green', 'blue', 'purple', 'orange']) {
        assert.ok(zone.includes(`aria-label="${t(`color.${name}`)}"`));
        assert.notEqual(t(`color.${name}`), `color.${name}`);
      }
    }
  });
});

test('toolbar event contracts preserve native disabled, permission guards and popover callbacks', async () => {
  await withChromeModule('/src/SelectionToolbar.jsx', ({ SelectionToolbar, GroupSelectionToolbar,
    ColorSwatches, FontSizeControl, FontColorSwatches, VoteControl }, { t, setLang }) => {
    const received = [];
    const record = (value) => received.push(value);
    for (const can of [false, true]) {
      const swatches = ColorSwatches({ can, onColor: record }).props.children;
      swatches[2].props.onClick();
      assert.equal(swatches[2].props.disabled, !can);
      const sizeControls = FontSizeControl({ item: { type: 'sticky' }, can, onFontSize: record }).props.children;
      sizeControls[0].props.onClick();
      sizeControls[2].props.onClick();
    }
    assert.deepEqual(received, [2, 13, 17]);
    const group = GroupSelectionToolbar({ anchor: { x: 1, y: 2 }, lockedCount: 2,
      canUnlock: false, onUnlockAll: () => record('unlock') });
    assert.equal(group.props.children.props.disabled, true);
    group.props.children.props.onClick();
    assert.equal(received.at(-1), 'unlock');
    let stopped = false;
    group.type(group.props).props.onMouseDown({ stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
    const vote = VoteControl({ timerSetupOpen: true, hasVoteTimer: true,
      onVoteButton: () => record('stop'), onTimerSetupOpenChange: record, onStartTimer: record });
    vote.props.children[0].props.onClick();
    vote.props.children[1].props.onClose();
    vote.props.children[1].props.onStart(5);
    assert.deepEqual(received.slice(-3), ['stop', false, 5]);
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const colors = FontColorSwatches({ fontColor: null, onFontColor: record, onClose: () => record('close') });
      for (const swatch of colors.props.children) {
        assert.equal(swatch.props.title, t(`font.color.${swatch.key}`));
        assert.notEqual(swatch.props.title, `font.color.${swatch.key}`);
      }
      colors.props.children[0].props.onClick();
      assert.deepEqual(received.slice(-2), [null, 'close']);
    }
    const toolbar = SelectionToolbar({ anchor: { x: 1, y: 2 }, item: { type: 'image' },
      can: false, canDelete: true, onBringToFront: record, onSendToBack: record, onDelete: () => record('delete') });
    const actions = toolbar.props.children.slice(-3);
    actions[0].props.onClick();
    actions[1].props.onClick();
    assert.equal(actions[2].props.disabled, false);
    actions[2].props.onClick();
    assert.equal(received.at(-1), 'delete');
  });
});
