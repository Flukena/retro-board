import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const NOW = 1_800_000_000_000;
const HOUR_MS = 3_600_000;
const SIGN_IN_URL = 'https://retroroom.party/yjs/api/auth/google/start?return=x';
const BOARD = Object.freeze({
  code: 'Ab3dEf7h', kind: 'board', locked: false, title: 'Sprint 12', link: '/b/Ab3dEf7h#tok12345tok12345',
  createdAt: NOW - 2 * HOUR_MS, lastActiveAt: NOW - 3 * 60_000,
});
const LOCKED = Object.freeze({
  code: 'Lk4mNo5p', kind: 'board', locked: true, title: null, link: '/b/Lk4mNo5p#lok12345lok12345', createdAt: NOW - HOUR_MS, lastActiveAt: null,
});
const POKER = Object.freeze({ ...BOARD, code: 'Pq9rSt2u', kind: 'poker', title: null, link: '/p/Pq9rSt2u#pok12345pok12345' });
const noop = () => {};
const ready = (rooms, extra = {}) => ({ status: 'ready', rooms, error: null, busyCode: null, ...extra });
const MODULE = '/src/client/account/MyBoardsDialog.jsx';
const render = ({ MyBoardsView }, state) => renderToStaticMarkup(React.createElement(MyBoardsView, {
  state, now: NOW, signInUrl: SIGN_IN_URL, onClose: noop, onRetry: noop, onAskRename: noop, onAskDelete: noop,
}));
const rowOf = (html, code) => html.split('<li').find((row) => row.includes(code));

test('My boards renders loading and the empty state in Thai and English', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      assert.ok(render(mod, { status: 'loading', rooms: [], error: null, busyCode: null }).includes(t('myBoards.loading')));
      const empty = render(mod, ready([]));
      assert.ok(empty.includes(t('account.myBoards')));
      assert.ok(empty.includes(t('myBoards.empty')));
      assert.ok(!empty.includes('<li'));
    }
    setLang('en');
    assert.ok(render(mod, ready([])).includes('Boards you create while signed in appear here.'));
  });
});

test('My boards lists each room with kind, times, Open link, Rename and Delete', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = render(mod, ready([BOARD, POKER]));
      const board = rowOf(html, BOARD.code);
      assert.ok(board.includes('Sprint 12'));
      assert.ok(board.includes(t('myBoards.kind.board')));
      assert.ok(board.includes(`href="${BOARD.link}"`));
      assert.ok(board.includes(t('myBoards.open')) && board.includes(t('myBoards.rename')) && board.includes(t('common.delete')));
      assert.ok(board.includes(t('myBoards.created', { time: t('common.hoursAgo', { n: 2 }) })));
      assert.ok(board.includes(t('myBoards.lastActive', { time: t('common.minutesAgo', { n: 3 }) })));
      assert.ok(!board.includes(t('myBoards.locked')));
      const poker = rowOf(html, POKER.code);
      assert.ok(poker.includes(t('poker.title')));
      assert.ok(poker.includes(`href="${POKER.link}"`));
    }
  });
});

test('a locked room shows the password badge, its code as the name, and no Rename', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const row = rowOf(render(mod, ready([LOCKED])), LOCKED.code);
      assert.ok(row.includes(t('myBoards.locked')));
      assert.ok(!row.includes(t('myBoards.rename')));
      assert.ok(row.includes(t('common.delete')));
      assert.ok(!row.includes(t('myBoards.lastActive', { time: '' }).trim()));
    }
  });
});

test('a failed load offers sign-in for 401 and retry otherwise', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const signIn = render(mod, { status: 'failed', rooms: [], error: 'sign-in', busyCode: null });
      assert.ok(signIn.includes(t('myBoards.error.signIn')));
      assert.ok(signIn.includes(`href="${SIGN_IN_URL}"`));
      assert.ok(!signIn.includes(t('account.retry')));
      for (const [error, key] of [['rate-limited', 'myBoards.error.rateLimited'], ['unavailable', 'account.failed']]) {
        const html = render(mod, { status: 'failed', rooms: [], error, busyCode: null });
        assert.ok(html.includes(t(key)), error);
        assert.ok(html.includes(t('account.retry')), error);
        assert.ok(html.includes('role="alert"'));
      }
    }
  });
});

test('an action refusal shows above the list, and a busy action disables the row buttons', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    setLang('en');
    for (const [error, key] of [['locked', 'myBoards.error.locked'], ['gone', 'myBoards.error.gone']]) {
      const html = render(mod, ready([BOARD], { error }));
      assert.ok(html.indexOf(t(key)) < html.indexOf('<li'), error);
    }
    const busy = rowOf(render(mod, ready([BOARD], { busyCode: BOARD.code })), BOARD.code);
    assert.equal((busy.match(/<button[^>]*disabled=""/g) || []).length, 2);
  });
});

test('delete copy names a Planning Poker room for poker and a board otherwise', async () => {
  await withChromeModule(MODULE, ({ DELETE_COPY_KEYS }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      assert.ok(t(DELETE_COPY_KEYS.poker.title).includes('Planning Poker'));
      assert.ok(t(DELETE_COPY_KEYS.poker.body).includes('Planning Poker'));
      assert.ok(!t(DELETE_COPY_KEYS.board.title).includes('Planning Poker'));
      assert.notEqual(t(DELETE_COPY_KEYS.board.body), t(DELETE_COPY_KEYS.poker.body));
    }
  });
});
