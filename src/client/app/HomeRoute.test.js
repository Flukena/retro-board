import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE } from '../account/signed-in-hint.js';

const MODULE = '/src/client/app/HomeRoute.jsx';

// The first render has no account answer yet, so only this browser's hint decides the page.
async function renderFirstPaint(hint) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => (key === SIGNED_IN_HINT_KEY ? hint : null), setItem() {}, removeItem() {} },
  });
  try {
    let html = '';
    await withChromeModule(MODULE, ({ default: HomeRoute }, { setLang }) => {
      setLang('en');
      html = renderToStaticMarkup(React.createElement(HomeRoute));
    });
    return html;
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

test('a hinted visitor gets the workspace skeleton and never the guest landing', async () => {
  const html = await renderFirstPaint(SIGNED_IN_HINT_VALUE);
  assert.match(html, /class="rb-workspace"/);
  assert.match(html, /aria-busy="true"/, 'the list is still loading');
  assert.match(html, /rb-workspace-create__trigger/, 'the create menu fills the masthead action slot');
  assert.doesNotMatch(html, /rb-landing__page/);
  assert.equal(html.match(/<main\b/g).length, 1, 'one main landmark');
});

test('a visitor without the hint gets the guest landing first', async () => {
  for (const hint of [null, '0']) {
    const html = await renderFirstPaint(hint);
    assert.match(html, /class="rb-landing__page"/, String(hint));
    assert.doesNotMatch(html, /rb-workspace/, String(hint));
    assert.equal(html.match(/<main\b/g).length, 1, 'one main landmark');
  }
});
