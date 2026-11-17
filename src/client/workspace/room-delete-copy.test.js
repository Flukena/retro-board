import test from 'node:test';
import assert from 'node:assert/strict';
import { setLang, t } from '../ui/i18n.js';
import { DELETE_COPY_KEYS } from './room-delete-copy.js';

test('delete copy names a Planning Poker room for poker and a board otherwise', () => {
  for (const lang of ['th', 'en']) {
    setLang(lang);
    assert.ok(t(DELETE_COPY_KEYS.poker.title).includes('Planning Poker'));
    assert.ok(t(DELETE_COPY_KEYS.poker.body).includes('Planning Poker'));
    assert.ok(!t(DELETE_COPY_KEYS.board.title).includes('Planning Poker'));
    assert.notEqual(t(DELETE_COPY_KEYS.board.body), t(DELETE_COPY_KEYS.poker.body));
  }
});

test('the type-to-confirm prompt names a room for poker and a board otherwise', () => {
  const WORDS = { th: { room: 'ห้อง', board: 'บอร์ด' }, en: { room: 'room', board: 'board' } };
  const CODE = 'Ab3dEf7h';
  for (const [lang, word] of Object.entries(WORDS)) {
    setLang(lang);
    const poker = t(DELETE_COPY_KEYS.poker.prompt, { code: CODE });
    const board = t(DELETE_COPY_KEYS.board.prompt, { code: CODE });
    assert.ok(poker.includes(word.room) && !poker.includes(word.board), `${lang} poker prompt: ${poker}`);
    assert.ok(board.includes(word.board), `${lang} board prompt: ${board}`);
    assert.ok(poker.includes(CODE) && board.includes(CODE));
  }
});
