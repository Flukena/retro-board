import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const ruleBody = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

// A friend selecting many cards marks every one of them. An endless
// box-shadow animation repaints each marked card on every frame, which kept a
// phone's main thread busy about two thirds of the time with 40 cards selected.
test('remote selection glow is static so many selected cards cost nothing per frame', async () => {
  await withChromeModule('/src/client/board/BoardCanvasStyles.jsx', ({ BoardCanvasStyles }) => {
    const css = renderToStaticMarkup(React.createElement(BoardCanvasStyles));
    const rule = ruleBody(css, '.rb-remote-selected-card');
    assert.match(rule, /box-shadow:/, 'the selection glow stays visible');
    assert.doesNotMatch(rule, /animation/, 'the glow must not animate');
  });
});
