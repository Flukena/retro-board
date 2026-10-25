import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, formatRelativeTime } from './relative-time.js';
import { getLang, setLang, t } from './i18n.js';

test('relative comment time switches units at minute, hour and day boundaries', () => {
  assert.deepEqual(relativeTime(0, 59999), { key: 'common.justNow' });
  for (const [elapsed, key, n] of [
    [60000, 'common.minutesAgo', 1],
    [3600000, 'common.hoursAgo', 1], [86400000, 'common.daysAgo', 1],
  ]) {
    assert.deepEqual(relativeTime(0, elapsed), { key, n });
  }
});

test('formatted relative time uses the active language and floored units', () => {
  const originalLang = getLang();
  try {
    for (const language of ['th', 'en']) {
      setLang(language);
      assert.equal(formatRelativeTime(0, 59999), t('common.justNow'));
      assert.equal(formatRelativeTime(0, 119999), t('common.minutesAgo', { n: 1 }));
      assert.equal(formatRelativeTime(0, 86399999), t('common.hoursAgo', { n: 23 }));
      assert.equal(formatRelativeTime(0, 172799999), t('common.daysAgo', { n: 1 }));
    }
  } finally {
    setLang(originalLang);
  }
});
