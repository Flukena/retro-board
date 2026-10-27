import test from 'node:test';
import assert from 'node:assert/strict';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('memory quantities use binary MiB and a consistent decimal place in both languages', async () => {
  await withChromeModule('/src/client/maintainer/monitoring-format.js', ({formatMib},{setLang}) => {
    for (const lang of ['th','en']) {
      setLang(lang);
      assert.equal(formatMib(0),'0.0 MiB');
      assert.equal(formatMib(1_572_864),'1.5 MiB');
    }
  });
});
