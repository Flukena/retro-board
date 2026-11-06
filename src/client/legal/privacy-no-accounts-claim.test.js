import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_OPTIONS } from '../ui/i18n.js';

// Sign-in is optional, so no privacy text may say the service has no accounts.
// Each list holds the wording the pre-sign-in policy used for that claim.
const NO_ACCOUNTS_PHRASES = Object.freeze({
  de: ['ohne Konten', 'keine Konten'],
  fr: ['sans compte', "pas de comptes"],
  es: ['sin cuentas', 'no hay cuentas'],
  pt: ['sem contas', 'não há contas'],
  id: ['tanpa akun', 'tidak ada akun'],
  vi: ['không cần tài khoản', 'không có tài khoản'],
  ja: ['アカウント不要', 'アカウントがない'],
  ko: ['계정이 필요 없는', '계정이 없기'],
  zh: ['无需账号', '没有账号'],
});
const PRIVACY_KEY_PREFIX = 'legal.privacy.';

test('every translated locale has a no-accounts phrase list', () => {
  const codes = LANGUAGE_OPTIONS.map((option) => option.code).filter((code) => code !== 'th' && code !== 'en');
  assert.deepEqual(Object.keys(NO_ACCOUNTS_PHRASES).sort(), codes.sort());
});

for (const [code, phrases] of Object.entries(NO_ACCOUNTS_PHRASES)) {
  test(`${code} privacy text does not claim there are no accounts`, async () => {
    const { default: locale } = await import(`../ui/locales/${code}.js`);
    const privacyText = Object.entries(locale).filter(([key]) => key.startsWith(PRIVACY_KEY_PREFIX));
    for (const [key, text] of privacyText) {
      for (const phrase of phrases) assert.ok(!text.includes(phrase), `${key} contains "${phrase}"`);
    }
  });
}
