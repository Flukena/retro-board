import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withSsrModule } from '../../test-support/ssr-load.js';

const EXPECTED_STYLE = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text-muted);font-family:var(--font-ui)';
const LOADING_COPY = { th: 'กำลังโหลด…', en: 'Loading…' };

test('loading view keeps full-screen themed markup and translated copy in Thai and English', async () => {
  await withSsrModule('/src/client/app/BoardLoading.jsx', async ({ default: BoardLoading }, { load }) => {
    const { setLang } = await load('/src/client/ui/i18n.js');
    for (const [code, text] of Object.entries(LOADING_COPY)) {
      setLang(code);
      assert.equal(renderToStaticMarkup(React.createElement(BoardLoading)), `<div style="${EXPECTED_STYLE}">${text}</div>`);
    }
  });
});
