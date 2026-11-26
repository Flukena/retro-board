import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('the star announces its state and lets a failed lookup be retried in Thai and English', async () => {
  await withChromeModule('/src/client/account/SaveBoardButton.jsx', ({ BoardStar, SaveBoardButton }, { setLang, t }) => {
    const render = props => renderToStaticMarkup(React.createElement(BoardStar, props));
    assert.equal(renderToStaticMarkup(React.createElement(SaveBoardButton)), '');
    for (const lang of ['en', 'th']) {
      setLang(lang);
      for (const saved of [false, true]) {
        const html = render({ saved });
        assert.ok(html.includes(`aria-pressed="${saved}"`));
        assert.ok(html.includes(t(saved ? 'savedBoards.remove' : 'savedBoards.save')));
      }
      assert.match(render({ saved: null }), /disabled=""/);
      const retry = render({ saved: null, failed: true });
      assert.ok(retry.includes(t('account.retry')));
      assert.doesNotMatch(retry, /disabled=""/);
    }
  });
});
