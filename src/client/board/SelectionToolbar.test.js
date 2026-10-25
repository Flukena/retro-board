import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('selection toolbar exposes only the controls allowed for its type and role', async () => {
  await withChromeModule('/src/client/board/SelectionToolbar.jsx', ({ SelectionToolbar }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const render = (type, isAdmin = false) => renderToStaticMarkup(React.createElement(SelectionToolbar, {
        anchor: { x: 100, y: 200 }, item: { type }, can: true, canDelete: false, isAdmin,
      }));
      for (const type of ['sticky', 'text', 'image']) {
        const markup = render(type, true);
        assert.ok(!markup.includes(t('zone.exportCsvTitle')));
        assert.ok(!markup.includes(t('zone.startVote')));
        assert.ok(!markup.includes(t('zone.revealCards')));
        assert.ok(markup.includes(`title="${t('selection.bringToFront')}"`));
        assert.ok(markup.includes(`title="${t('selection.sendToBack')}"`));
        for (const key of ['selection.bringToFront', 'selection.sendToBack']) assert.ok(markup.includes(`aria-label="${t(key)}"`));
        assert.match(markup, /lucide-arrow-up-to-line/);
        assert.match(markup, /lucide-arrow-down-to-line/);
        assert.match(markup, /class="rb-icon-btn rb-icon-btn--danger"[^>]*disabled=""/);
      }
      for (const name of ['yellow', 'red', 'green', 'blue', 'purple', 'orange']) {
        assert.ok(render('sticky').includes(`aria-label="${t(`color.${name}`)}"`));
        assert.notEqual(t(`color.${name}`), `color.${name}`);
      }
    }
  });
});

test('toolbar event contracts preserve native disabled, permission guards and popover callbacks', async () => {
  await withChromeModule('/src/client/board/SelectionToolbar.jsx', ({ SelectionToolbar, GroupSelectionToolbar,
    ColorSwatches, FontSizeControl, FontColorSwatches }, { t, setLang }) => {
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
    assert.deepEqual(received, [2, 18, 22]);
    const group = GroupSelectionToolbar({ anchor: { x: 1, y: 2 }, lockedCount: 2,
      canUnlock: false, onUnlockAll: () => record('unlock') });
    assert.equal(group.props.children[0].props.disabled, true);
    group.props.children[0].props.onClick();
    assert.equal(received.at(-1), 'unlock');
    let stopped = false;
    group.type(group.props).props.onMouseDown({ stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
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

test('save template is accessible for a group containing zones and emits the callback', async () => {
  await withChromeModule('/src/client/board/SelectionToolbar.jsx', ({ SelectionToolbar, GroupSelectionToolbar }, { t, setLang }) => {
    let saves = 0;
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const label = t('selection.saveTemplate');
      assert.notEqual(label, 'selection.saveTemplate');
      const props = { anchor: { x: 0, y: 0 }, onSaveTemplate: () => { saves += 1; } };
      for (const zoneCount of [0, 1, 2]) {
        const group = GroupSelectionToolbar({ ...props, zoneCount, lockedCount: 0 });
        const markup = renderToStaticMarkup(group);
        assert.equal(markup.includes(`aria-label="${label}"`), zoneCount > 0);
        if (zoneCount) {
          const save = group.props.children.find((child) => child?.props?.onSaveTemplate);
          save.type(save.props).props.onClick();
        }
      }
      for (const type of ['sticky', 'text', 'image']) {
        assert.ok(!renderToStaticMarkup(SelectionToolbar({ ...props, item: { type } })).includes(label));
      }
    }
    assert.equal(saves, 4);
  });
});

test('measured desktop toolbar preserves visible font popovers unless its actions overflow', () => {
  const css = readFileSync(new URL('./selection-toolbar.css', import.meta.url), 'utf8');
  assert.match(css, /\.rb-selection-toolbar\s*\{[^}]*max-width:\s*var\(--rb-selection-max-width-px, none\)/);
  assert.match(css, /\.rb-selection-toolbar\s*\{[^}]*overflow:\s*visible/);
  assert.match(css, /\.rb-selection-toolbar\[data-toolbar-overflow="true"\]\s*\{[^}]*overflow-x:\s*auto/);
});

test('saved drawing edit action is accessible in both languages and honors the existing editing lock', async () => {
  await withChromeModule('/src/client/board/SelectionToolbar.jsx', ({SelectionToolbar},{t,setLang}) => {
    for(const lang of ['th','en']) for(const can of [false,true]) {
      setLang(lang);let calls=0;
      const tree=SelectionToolbar({anchor:{x:0,y:0},item:{type:'image'},can,onEditDrawing:()=>{calls++;}});
      const action=tree.props.children.find(child=>child?.props?.['aria-label']===t('draw.editImage'));
      assert.ok(action);assert.equal(action.props.disabled,!can);action.props.onClick();assert.equal(calls,Number(can));
    }
  });
});
