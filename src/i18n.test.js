import test from 'node:test';
import assert from 'node:assert/strict';
import { getLang, setLang, t } from './i18n.js';

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
