import test from 'node:test';
import assert from 'node:assert/strict';

import { copyTextToClipboard } from './clipboard.js';

test('reports clipboard success only after the write resolves', async () => {
  let copied = null;
  const ok = await copyTextToClipboard({
    async writeText(value) { copied = value; },
  }, 'https://example.test/board');
  assert.equal(ok, true);
  assert.equal(copied, 'https://example.test/board');
});

test('reports clipboard rejection and unavailable APIs without throwing', async () => {
  assert.equal(await copyTextToClipboard({
    async writeText() { throw new Error('permission denied'); },
  }, 'secret'), false);
  assert.equal(await copyTextToClipboard(null, 'secret'), false);
});
