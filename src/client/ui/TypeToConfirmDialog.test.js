import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const noop = () => {};
const PROPS = Object.freeze({
  title: 'Delete board', body: 'Gone for good', prompt: 'Type Ab3dEf7h to confirm', expected: 'Ab3dEf7h',
  cancelLabel: 'Cancel', confirmLabel: 'Delete', onCancel: noop, onConfirm: noop, onTypedChange: noop,
});
// The confirm button is the last button; Cancel stays enabled unless busy.
const confirmButton = (html) => html.match(/<button[^>]*>[^<]*<\/button>/g).at(-1);

test('TypeToConfirm enables Delete only on the exact, case-sensitive code', async () => {
  await withChromeModule('/src/client/ui/TypeToConfirmDialog.jsx', ({ TypeToConfirmView }) => {
    const render = (typed, extra = {}) => renderToStaticMarkup(React.createElement(TypeToConfirmView, { ...PROPS, typed, ...extra }));
    for (const typed of ['', 'ab3def7h', 'AB3DEF7H', 'Ab3dEf7h ']) {
      assert.match(confirmButton(render(typed)), /disabled=""/, JSON.stringify(typed));
    }
    const exact = render('Ab3dEf7h');
    assert.doesNotMatch(confirmButton(exact), /disabled=""/);
    assert.match(confirmButton(exact), /rb-btn--danger/);
    assert.match(exact, /Type Ab3dEf7h to confirm/);
    assert.match(exact, /role="dialog" aria-modal="true"/);
    assert.match(confirmButton(render('Ab3dEf7h', { busy: true })), /disabled=""/);
  });
});
