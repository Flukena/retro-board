import test from 'node:test';
import assert from 'node:assert/strict';
import { getLang, initialLanguage, setLang, t } from './i18n.js';

test('Thai vote stop and result copy uses Thai words and preserves count placeholders', () => {
  const originalLang = getLang();
  try {
    setLang('th');
    assert.equal(t('topbar.stopVote'), 'หยุดโหวต');
    assert.equal(t('vote.results', { n: 3, users: 2 }), 'ผลโหวต: 3 โหวต จาก 2 คน');
    for (const key of ['topbar.stopVote', 'vote.results']) assert.doesNotMatch(t(key, { n: 3, users: 2 }), /Stop|votes|users/);
    setLang('en');
    assert.equal(t('topbar.stopVote'), 'Stop Vote');
    assert.equal(t('vote.results', { n: 3, users: 2 }), 'Results: 3 votes from 2 users');
  } finally {
    setLang(originalLang);
  }
});

// Card activity, comment and vote times on Thai pages; every placeholder is the number itself.
const RELATIVE_TIME_KEYS = Object.freeze(['common.justNow', 'common.minutesAgo', 'common.hoursAgo', 'common.daysAgo']);
const PLACEHOLDER_TOKEN = /\{[a-zA-Z]+\}/g;
const LATIN_LETTER = /[A-Za-z]/;

test('Thai relative times are written in Thai, apart from their number placeholder', () => {
  const originalLang = getLang();
  try {
    setLang('th');
    for (const key of RELATIVE_TIME_KEYS) {
      const copy = t(key);
      assert.notEqual(copy, key, `${key} has a Thai entry`);
      assert.doesNotMatch(copy.replaceAll(PLACEHOLDER_TOKEN, ''), LATIN_LETTER, `${key}: ${copy}`);
    }
  } finally {
    setLang(originalLang);
  }
});

test('a first visit starts in English, whatever the browser language; a saved choice wins', () => {
  assert.equal(initialLanguage(null), 'en');
  assert.equal(initialLanguage('xx'), 'en', 'an unknown saved value falls back to English');
  assert.equal(initialLanguage('th'), 'th');
  assert.equal(initialLanguage('ko'), 'ko', 'a saved language that is not loaded yet is still honoured');
});

test('picking an on-demand language loads it before switching; unknown codes change nothing', async () => {
  const originalLang = getLang();
  try {
    setLang('en');
    const english = t('settings.lang');
    await setLang('ja');
    assert.equal(getLang(), 'ja');
    assert.notEqual(t('settings.lang'), english, 'Japanese text, not the English fallback');
    await setLang('xx');
    assert.equal(getLang(), 'ja');
  } finally {
    await setLang(originalLang);
  }
});

test('the last language picked wins when loads overlap', async () => {
  const originalLang = getLang();
  try {
    setLang('en');
    const slow = setLang('zh');
    setLang('th');
    await slow;
    assert.equal(getLang(), 'th');
  } finally {
    await setLang(originalLang);
  }
});

test('every translation output is byte-identical to the pre-extraction fixture', async () => {
  const { readFileSync } = await import('node:fs');
  const frozen = readFileSync(new URL('./fixtures/i18n-outputs.json', import.meta.url), 'utf8');
  const outputs = {};
  const originalLang = getLang();
  try {
    for (const [code, entries] of Object.entries(JSON.parse(frozen))) {
      await setLang(code);
      outputs[code] = Object.fromEntries(Object.keys(entries).map(key => [key, t(key)]));
    }
    assert.equal(JSON.stringify(outputs, null, 2) + '\n', frozen);
  } finally {
    await setLang(originalLang);
  }
});

test('loaded languages switch synchronously; missing entries fall back to English then the key; failed chunks keep language', async () => {
  const { withChromeModule } = await import('../../test-support/chrome-test-helper.js');
  await withChromeModule('/src/client/ui/i18n.js', async (runtime) => {
    runtime.setLang('th');
    assert.equal(runtime.getLang(), 'th');
    await runtime.setLang('zh');
    assert.equal(runtime.t('settings.lang'), 'fixture language');
    assert.equal(runtime.t('app.title'), 'RetroRoom');
    const absentKey = ['absent', 'translation'].join('.');
    assert.equal(runtime.t(absentKey), absentKey);
    await runtime.setLang('ja');
    assert.equal(runtime.getLang(), 'zh');
  }, { plugins: [{
    name: 'locale-network-fixture',
    transform(_source, id) {
      if (id.endsWith('/locales/zh.js')) return 'export default { "settings.lang": "fixture language" };';
      if (id.endsWith('/locales/ja.js')) return 'throw new Error("chunk unavailable"); export default {};';
    },
  }] });
});
