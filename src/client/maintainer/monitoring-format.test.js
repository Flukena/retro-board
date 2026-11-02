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

test('room ages use elapsed server time, floor units and leave unknown or future dates unknown', async () => {
  await withChromeModule('/src/client/maintainer/monitoring-format.js', ({formatRoomAge, formatRoomTime}, {setLang, t}) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const [elapsedMs, unit, n] of [[0, 'seconds', 0], [59_999, 'seconds', 59], [60_000, 'minutes', 1], [3_600_000, 'hours', 1], [86_400_000, 'days', 1]]) {
        assert.equal(formatRoomAge(1000, 1000 + elapsedMs), t(`maintainer.${unit}`, {n}));
      }
      for (const value of [null, undefined, -1, '1000']) {
        assert.equal(formatRoomAge(value, 5000), t('maintainer.timeUnknown'));
        assert.equal(formatRoomTime(value), t('maintainer.timeUnknown'));
      }
      assert.equal(formatRoomAge(6000, 5000), t('maintainer.timeUnknown'));
    }
  });
});
