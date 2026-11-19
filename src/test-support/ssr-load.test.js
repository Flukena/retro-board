import test from 'node:test';
import assert from 'node:assert/strict';
import { withSsrModule } from './ssr-load.js';

const LOCALE_PATH = '/src/client/ui/locales/en.js';

test('SSR loader shares module instances with subsequent loads', async () => {
  await withSsrModule(LOCALE_PATH, async (subject, { load }) => {
    assert.equal(subject.default['app.title'], 'RetroRoom');
    assert.equal((await load(LOCALE_PATH)).default, subject.default);
  });
});

test('SSR loader preserves callback failures while disposing its server', async () => {
  const failure = new Error('callback failed');
  await assert.rejects(withSsrModule(LOCALE_PATH, () => { throw failure; }), error => error === failure);
});
