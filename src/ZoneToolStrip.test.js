import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

const ITEM = { id: 'target', type: 'zone', color: 2, fontSize: 24 };
test('zone strip uses localized accessible tools and native edit/delete disabling', async () => {
  await withChromeModule('/src/ZoneToolStrip.jsx', ({ ZoneToolStrip }, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const canEdit of [false, true]) {
        const html = renderToStaticMarkup(React.createElement(ZoneToolStrip, {
          item: ITEM, canEdit, canDelete: false, actions: {},
        }));
        for (const key of ['zone.lockToggle.on', 'zone.exportCsvTitle', 'selection.saveTemplate',
          'selection.bringToFront', 'selection.sendToBack', 'common.delete', 'font.decrease', 'font.increase']) {
          assert.ok(html.includes(`aria-label="${t(key)}"`));
          assert.notEqual(t(key), key);
        }
        assert.match(html, /aria-label="[^"\n]+"[^>]* disabled=""/);
        assert.equal((html.match(/disabled=""/g) || []).length, canEdit ? 1 : 12);
      }
    }
  });
});

test('zone strip isolates events and forwards each action with its zone id', async () => {
  await withChromeModule('/src/ZoneToolStrip.jsx', ({ ZoneToolStrip }) => {
    const calls = [];
    const actions = Object.fromEntries(['color', 'fontSize', 'toggleLock', 'exportCsv', 'saveTemplate',
      'bringToFront', 'sendToBack', 'remove'].map((name) => [name, (...args) => calls.push([name, ...args])]));
    const tree = ZoneToolStrip({ item: ITEM, canEdit: true, canDelete: true, actions });
    for (const name of ['onMouseDown', 'onDoubleClick', 'onClick']) tree.props[name]({ stopPropagation: () => calls.push('stop') });
    assert.deepEqual(calls.splice(0), ['stop', 'stop', 'stop']);
    tree.props.children[0].props.onColor(1); tree.props.children[1].props.onFontSize(26);
    for (const button of tree.props.children.slice(2)) button.props.onClick();
    assert.deepEqual(calls, [['color', ITEM.id, 1], ['fontSize', ITEM.id, 26],
      ...['toggleLock', 'exportCsv', 'saveTemplate', 'bringToFront', 'sendToBack', 'remove'].map((name) => [name, ITEM.id])]);
  });
});
