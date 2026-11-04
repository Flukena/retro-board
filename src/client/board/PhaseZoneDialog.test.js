import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const buttonsOf = (element, found = []) => {
  if (!React.isValidElement(element)) return found;
  if (typeof element.type === 'function') return buttonsOf(element.type(element.props), found);
  if (element.type === 'button') found.push(element);
  React.Children.forEach(element.props.children, (child) => buttonsOf(child, found));
  return found;
};

test('the picker lists each zone with its card count, then the whole board', async () => {
  await withChromeModule('/src/client/board/PhaseZoneDialog.jsx', ({ PhaseZoneDialog }, { t }) => {
    const picks = [];
    const choices = [{ id: 'a', title: 'Went well', cardCount: 3 }, { id: 'b', title: '', cardCount: 0 }];
    const dialog = PhaseZoneDialog({ choices, onPick: (id) => picks.push(id), onCancel: () => {} });
    const list = dialog.props.children.find((child) => child?.type === 'ul');
    const html = renderToStaticMarkup(list);
    assert.match(html, /Went well/);
    assert.match(html, new RegExp(t('phase.zoneCards', { n: 3 })));
    assert.ok(html.includes(t('export.csv.untitledZone')));
    assert.ok(html.indexOf('Went well') < html.indexOf(t('phase.wholeBoard')));
    buttonsOf(list).forEach((button) => button.props.onClick());
    assert.deepEqual(picks, ['a', 'b', null]);
  });
});
