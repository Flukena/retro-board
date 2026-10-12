import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('toast announces status, chooses one appearance and closes only sticky messages', async () => {
  await withChromeModule('/src/Toast.jsx', ({ Toast }, { t }) => {
    assert.equal(Toast({ toast: null }), null);
    const render = (toast) => renderToStaticMarkup(React.createElement(Toast, { toast }));
    const warn = render({ msg: 'Warning', type: 'warn', sticky: true });
    assert.match(warn, /rb-surface--toast-warn/);
    assert.doesNotMatch(warn, /rb-surface--toast(?:\s|")/);
    assert.match(warn, /role="status" aria-live="polite"/);
    assert.ok(warn.includes(`aria-label="${t('common.close')}"`));
    const normal = render({ msg: 'Saved' });
    assert.match(normal, /rb-surface--toast(?:\s|")/);
    assert.doesNotMatch(normal, /<button/);
    assert.equal(Toast({ toast: { msg: 'Saved', t: 123 } }).key, '123');
  });
});
