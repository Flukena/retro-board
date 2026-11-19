import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { HostIFrame, createHostDocument } from '../../test-support/host-document.js';

test('boundary preserves a healthy board and offers translated reload after a render error', async () => {
  await withChromeModule('/src/client/app/BoardErrorBoundary.jsx', ({ BoardErrorBoundary }, { setLang, t }) => {
    const child = React.createElement('p', null, 'Healthy board');
    const boundary = new BoardErrorBoundary({ children: child });
    assert.equal(boundary.render(), child);
    boundary.state = BoardErrorBoundary.getDerivedStateFromError(new Error('broken child'));
    for (const language of ['en', 'th']) {
      setLang(language);
      const markup = renderToStaticMarkup(boundary.render());
      assert.ok(markup.includes(t('resilience.error.title')));
      assert.ok(markup.includes(t('resilience.reload')));
      assert.ok(markup.includes('role="alert"'));
      assert.ok(!markup.includes('Healthy board'));
    }
  });
});

function ThrowingDescendant() {
  throw new Error('boundary regression fixture');
}

test('React catches a throwing descendant and mounts the translated recovery screen', async (context) => {
  const oldWindow = globalThis.window;
  globalThis.window = { HTMLIFrameElement: HostIFrame };
  context.after(() => {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  await withChromeModule('/src/client/app/BoardErrorBoundary.jsx', ({ BoardErrorBoundary }, { setLang, t }) => {
    const document = createHostDocument();
    for (const language of ['th', 'en']) {
      setLang(language);
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        assert.doesNotThrow(() => flushSync(() => root.render(
          React.createElement(BoardErrorBoundary, null, React.createElement(ThrowingDescendant)),
        )));
        assert.ok(container.textContent.includes(t('resilience.error.title')));
        assert.ok(container.textContent.includes(t('resilience.reload')));
        const panel = container.firstChild.firstChild;
        assert.equal(panel.attributes.get('role'), 'alert');
      } finally {
        flushSync(() => root.unmount());
      }
    }
  });
});
