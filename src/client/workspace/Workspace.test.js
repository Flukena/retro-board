import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const MODULE = '/src/client/workspace/Workspace.jsx';
const LANGS = Object.freeze(['th', 'en']);
const NOW = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SIGN_IN_URL = 'https://retroroom.party/yjs/api/auth/google/start?return=x';
const PREVIEW_ZONES = Object.freeze([
  { x: 0, y: 0, w: 400, h: 600, color: 2 },
  { x: 420, y: 0, w: 400, h: 600, color: 1 },
  { x: 840, y: 0, w: 400, h: 600, color: 3 },
]);
const BOARD = Object.freeze({
  code: 'Ab3dEf7h', kind: 'board', locked: false, title: 'Sprint 12', link: '/b/Ab3dEf7h#tok12345tok12345',
  createdAt: NOW - 2 * HOUR_MS, lastActiveAt: NOW - 3 * MINUTE_MS, preview: { zones: PREVIEW_ZONES },
});
// A board nobody has opened since it was made: the relay sends no activity time.
const UNTOUCHED = Object.freeze({
  code: 'Em7pTy2b', kind: 'board', locked: false, title: null, link: '/b/Em7pTy2b#emp12345emp12345',
  createdAt: NOW - 2 * DAY_MS, lastActiveAt: null, preview: null,
});
const LOCKED = Object.freeze({
  code: 'Lk4mNo5p', kind: 'board', locked: true, title: 'Private team name', link: '/b/Lk4mNo5p#lok12345lok12345',
  createdAt: NOW - HOUR_MS, lastActiveAt: NOW - HOUR_MS, preview: null,
});
const POKER = Object.freeze({
  code: 'Pq9rSt2u', kind: 'poker', locked: false, title: null, link: '/p/Pq9rSt2u#pok12345pok12345',
  createdAt: NOW - DAY_MS, lastActiveAt: NOW - DAY_MS, preview: null,
});
const ROOMS = Object.freeze([BOARD, UNTOUCHED, LOCKED, POKER]);
const noop = () => {};
const ready = (rooms, extra = {}) => ({ status: 'ready', rooms, error: null, busyCode: null, ...extra });
const failed = (error) => ({ status: 'failed', rooms: [], error, busyCode: null });
const LOADING = Object.freeze({ status: 'loading', rooms: [], error: null, busyCode: null });

const render = ({ WorkspaceView }, state, props = {}) => renderToStaticMarkup(React.createElement(WorkspaceView, {
  state, query: '', sort: 'recent', now: NOW, signInUrl: SIGN_IN_URL, canCreate: true, creating: false, createError: null,
  onQuery: noop, onSort: noop, onRetry: noop, onCreateFirst: noop, onAskRename: noop, onAskDelete: noop,
  menuCode: null, onToggleMenu: noop, ...props,
}));
const cardsOf = (html) => html.match(/<li class="rb-workspace-card[^"]*"[\s\S]*?<\/li>/g) ?? [];
const cardOf = (html, code) => cardsOf(html).find((card) => card.includes(code));
const countOf = (html, pattern) => html.match(pattern)?.length ?? 0;
const menuItemsOf = (card) => [...card.matchAll(/<(button|a)\b([^>]*role="menuitem"[^>]*)>([\s\S]*?)<\/\1>/g)]
  .map(([, , attributes, inner]) => ({ attributes, inner }));
const menuItemLabelled = (card, label) => menuItemsOf(card).find(({ inner }) => inner.includes(label));
const emptyStateCopy = (t) => [t('workspace.empty.title'), t('workspace.empty.body'), t('workspace.empty.create')];
// React escapes text as HTML; the English old-boards note carries an apostrophe.
const asHtml = (text) => text.replaceAll('&', '&amp;').replaceAll("'", '&#x27;');

// The fixed copy from the plan's global constraints; t() falls back to the key, so check the words themselves.
const FIXED_COPY = Object.freeze({
  'workspace.title': ['บอร์ดของฉัน', 'My boards'],
  'workspace.intro': ['บอร์ดที่คุณสร้างขณะล็อกอิน เปิด เปลี่ยนชื่อ หรือลบได้จากที่นี่', 'Boards you created while signed in. Open, rename or delete them here.'],
  'workspace.search': ['ค้นหาชื่อหรือรหัสบอร์ด', 'Search by name or code'],
  'workspace.sort': ['เรียง', 'Sort'],
  'workspace.sort.recent': ['ใช้ล่าสุด', 'Last used'],
  'workspace.sort.created': ['สร้างล่าสุด', 'Newest'],
  'workspace.sort.name': ['ชื่อ ก–ฮ', 'Name A–Z'],
  'workspace.noMatch': ['ไม่พบบอร์ดที่ตรงกับคำค้น', 'No boards match your search.'],
  'workspace.oldBoards': ['บอร์ดที่สร้างก่อน 17 พ.ย. 2026 ยังไม่อยู่ในรายการนี้ เปิดได้จากลิงก์เดิมเหมือนเดิม', "Boards made before 17 Nov 2026 aren't listed here. Open them from their link as before."],
  'workspace.empty.title': ['ยังไม่มีบอร์ด', 'No boards yet'],
  'workspace.empty.body': ['บอร์ดที่คุณสร้างขณะล็อกอินจะแสดงที่นี่ เปิด เปลี่ยนชื่อ หรือลบได้จากหน้านี้', 'Boards you create while signed in show up here, ready to open, rename or delete.'],
  'workspace.empty.create': ['สร้างบอร์ดแรก', 'Create your first board'],
  'workspace.badge.locked': ['ล็อกรหัส', 'Locked'],
  'workspace.card.poker': ['Planning Poker · {code}', 'Planning Poker · {code}'],
  'workspace.card.noZones': ['ยังไม่มีโซน', 'No zones yet'],
  'workspace.card.options': ['ตัวเลือกของ {title}', 'Options for {title}'],
  'workspace.card.renameLocked': ['บอร์ดล็อกรหัสเปลี่ยนชื่อได้ในบอร์ด', 'Rename a locked board from inside it.'],
  'workspace.card.delete': ['ลบบอร์ด…', 'Delete board…'],
});

test('workspace page and card copy matches the fixed Thai and English text', async () => {
  await withChromeModule(MODULE, (_, { t, setLang }) => {
    for (const [index, lang] of LANGS.entries()) {
      setLang(lang);
      for (const [key, copy] of Object.entries(FIXED_COPY)) assert.equal(t(key), copy[index], `${lang}: ${key}`);
    }
    setLang('en');
  });
});

test('loading renders WORKSPACE_SKELETON_CARDS busy placeholders and no empty-state copy', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of LANGS) {
      setLang(lang);
      const html = render(mod, LOADING);
      assert.equal(countOf(html, /rb-workspace-card--skeleton/g), mod.WORKSPACE_SKELETON_CARDS, lang);
      assert.match(html, /<ul[^>]*aria-busy="true"/);
      assert.ok(html.includes(t('myBoards.loading')), lang);
      for (const copy of emptyStateCopy(t)) assert.ok(!html.includes(copy), `${lang}: ${copy}`);
      assert.ok(!html.includes(asHtml(t('workspace.oldBoards'))), lang);
    }
    setLang('en');
  });
});

test('ready with no rooms shows the empty state, the create call to action and the old-boards note', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of LANGS) {
      setLang(lang);
      const html = render(mod, ready([]));
      assert.match(html, new RegExp(`<h1[^>]*>${t('workspace.title')}`), lang);
      for (const copy of emptyStateCopy(t)) assert.ok(html.includes(copy), `${lang}: ${copy}`);
      assert.match(html, new RegExp(`<button[^>]*>(?:(?!</button>).)*${t('workspace.empty.create')}</button>`), lang);
      assert.ok(html.includes(asHtml(t('workspace.oldBoards'))), lang);
      assert.equal(cardsOf(html).length, 0, lang);
      assert.ok(!html.includes(t('workspace.noMatch')), lang);
      assert.ok(!html.includes('aria-busy="true"'), lang);
    }
    setLang('en');
  });
});

test('the empty-state create button is disabled while creating and a create failure is announced', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    setLang('en');
    const idle = render(mod, ready([]));
    assert.doesNotMatch(idle, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Create your first board/);
    const busy = render(mod, ready([]), { creating: true });
    assert.match(busy, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Create your first board/);
    const refused = render(mod, ready([]), { createError: { code: 'unavailable' } });
    assert.match(refused, /role="alert"/);
    assert.ok(!idle.includes('role="alert"'));
    assert.ok(refused.includes(t('workspace.empty.create')));
  });
});

test('the empty-state create button stays disabled until the account is confirmed signed in', async () => {
  await withChromeModule(MODULE, (mod, { setLang }) => {
    setLang('en');
    const waiting = render(mod, ready([]), { canCreate: false });
    assert.match(waiting, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Create your first board/);
  });
});

test('ready lists one card per room with its thumbnail, name, activity and one link', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of LANGS) {
      setLang(lang);
      const html = render(mod, ready(ROOMS));
      assert.equal(cardsOf(html).length, ROOMS.length, lang);
      assert.match(html, new RegExp(`<h1[^>]*>${t('workspace.title')}`), lang);
      assert.ok(html.includes(asHtml(t('workspace.oldBoards'))), lang);

      const board = cardOf(html, BOARD.title);
      assert.equal(countOf(board.match(/<svg[^>]*class="rb-template-thumbnail[\s\S]*?<\/svg>/)[0], /<rect/g), PREVIEW_ZONES.length);
      assert.ok(board.includes(t('myBoards.lastActive', { time: t('common.minutesAgo', { n: 3 }) })), lang);

      const untouched = cardOf(html, UNTOUCHED.code);
      assert.ok(untouched.includes(t('workspace.card.noZones')), lang);
      assert.ok(untouched.includes(t('myBoards.created', { time: t('common.daysAgo', { n: 2 }) })), lang);
      assert.ok(!untouched.includes(t('myBoards.lastActive', { time: '' }).trim()), `${lang}: no activity line for a null time`);

      const locked = cardOf(html, LOCKED.code);
      assert.ok(locked.includes(t('workspace.badge.locked')), lang);
      assert.ok(!html.includes(LOCKED.title), `${lang}: a locked board never shows its title`);

      const poker = cardOf(html, POKER.code);
      assert.ok(poker.includes(`Planning Poker · ${POKER.code}`), lang);

      for (const room of ROOMS) {
        const card = cardOf(html, room.code);
        assert.equal(countOf(card, /<a\b/g), 1, `${lang}: ${room.code} has one link`);
        assert.ok(card.includes(`href="${room.link}"`), `${lang}: ${room.code} links to its room`);
        assert.ok(card.includes('aria-expanded="false"'), `${lang}: ${room.code} menu closed`);
      }
      assert.ok(!html.includes('role="menu"'), lang);
    }
    setLang('en');
  });
});

test('a card names its options button after the room name', async () => {
  await withChromeModule(MODULE, (mod, { t }) => {
    const html = render(mod, ready([BOARD, POKER]));
    assert.ok(cardOf(html, BOARD.title).includes(`aria-label="${t('workspace.card.options', { title: BOARD.title })}"`));
    assert.ok(cardOf(html, POKER.code).includes(`aria-label="${t('workspace.card.options', { title: POKER.code })}"`));
  });
});

test('the open card menu offers rename by rule', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of LANGS) {
      setLang(lang);
      const rename = t('myBoards.rename');
      const open = (code) => render(mod, ready(ROOMS), { menuCode: code });

      const boardHtml = open(BOARD.code);
      assert.equal(countOf(boardHtml, /role="menu"/g), 1, `${lang}: one menu at a time`);
      const board = cardOf(boardHtml, BOARD.title);
      assert.ok(board.includes('aria-expanded="true"'), lang);
      assert.doesNotMatch(menuItemLabelled(board, rename).attributes, /disabled/, `${lang}: plain board rename enabled`);
      assert.ok(menuItemLabelled(board, t('workspace.card.delete')), lang);
      assert.match(menuItemLabelled(board, t('myBoards.open')).attributes, new RegExp(`href="${BOARD.link}"`), lang);
      assert.ok(!board.includes(t('workspace.card.renameLocked')), lang);

      const locked = cardOf(open(LOCKED.code), LOCKED.code);
      const lockedRename = menuItemLabelled(locked, rename).attributes;
      assert.match(lockedRename, /aria-disabled="true"/, `${lang}: locked rename is announced as unavailable`);
      assert.doesNotMatch(lockedRename, /\sdisabled=""/, `${lang}: locked rename stays focusable so its hint is read`);
      const hintId = lockedRename.match(/aria-describedby="([^"]+)"/)?.[1];
      assert.ok(hintId, `${lang}: locked rename points at its hint`);
      assert.ok(locked.includes(`id="${hintId}" class="rb-workspace-card__hint">${asHtml(t('workspace.card.renameLocked'))}</p>`), lang);
      assert.ok(menuItemLabelled(locked, t('workspace.card.delete')), lang);

      const poker = cardOf(open(POKER.code), POKER.code);
      assert.equal(menuItemLabelled(poker, rename), undefined, `${lang}: poker has no rename`);
      assert.ok(menuItemLabelled(poker, t('workspace.card.delete')), lang);
      assert.ok(menuItemLabelled(poker, t('myBoards.open')), lang);
    }
    setLang('en');
  });
});

test('rename and delete are disabled while any room action is in flight', async () => {
  await withChromeModule(MODULE, (mod, { t }) => {
    const html = render(mod, ready(ROOMS, { busyCode: POKER.code }), { menuCode: BOARD.code });
    const board = cardOf(html, BOARD.title);
    assert.match(menuItemLabelled(board, t('myBoards.rename')).attributes, /disabled=""/);
    assert.match(menuItemLabelled(board, t('workspace.card.delete')).attributes, /disabled=""/);
  });
});

test('a failed list shows the matching error copy and a Retry button, never the empty state', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    const cases = [['unavailable', 'account.failed'], ['rate-limited', 'myBoards.error.rateLimited']];
    for (const lang of LANGS) {
      setLang(lang);
      for (const [error, key] of cases) {
        const html = render(mod, failed(error));
        assert.match(html, new RegExp(`role="alert"[^>]*>[\\s\\S]*${t(key)}`), `${lang}: ${error}`);
        assert.match(html, new RegExp(`<button[^>]*>${t('account.retry')}</button>`), `${lang}: ${error}`);
        for (const copy of emptyStateCopy(t)) assert.ok(!html.includes(copy), `${lang}: ${error}: ${copy}`);
        assert.equal(cardsOf(html).length, 0);
      }
      const signIn = render(mod, failed('sign-in'));
      assert.ok(signIn.includes(t('myBoards.error.signIn')), lang);
      assert.match(signIn, new RegExp(`<a[^>]*href="${SIGN_IN_URL.replaceAll('?', '\\?')}"[^>]*>${t('account.signIn')}</a>`), lang);
      assert.ok(!signIn.includes(t('account.retry')), lang);
      for (const copy of emptyStateCopy(t)) assert.ok(!signIn.includes(copy), `${lang}: sign-in: ${copy}`);
    }
    setLang('en');
  });
});

test('a refused rename or delete keeps the list and shows its notice without Retry', async () => {
  await withChromeModule(MODULE, (mod, { t }) => {
    const html = render(mod, ready([BOARD], { error: 'locked' }));
    assert.match(html, new RegExp(`role="alert"[^>]*>[\\s\\S]*${t('myBoards.error.locked')}`));
    assert.equal(cardsOf(html).length, 1);
    assert.ok(!html.includes(t('account.retry')));
  });
});

test('a query with no match shows workspace.noMatch', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of LANGS) {
      setLang(lang);
      const none = render(mod, ready(ROOMS), { query: 'zzzz-nothing' });
      assert.ok(none.includes(t('workspace.noMatch')), lang);
      assert.equal(cardsOf(none).length, 0, lang);
      for (const copy of emptyStateCopy(t)) assert.ok(!none.includes(copy), `${lang}: ${copy}`);
      assert.match(none, /<input[^>]*type="search"[^>]*value="zzzz-nothing"/, lang);

      const some = render(mod, ready(ROOMS), { query: '  SPRINT ' });
      assert.equal(cardsOf(some).length, 1, lang);
      assert.ok(!some.includes(t('workspace.noMatch')), lang);
    }
    setLang('en');
  });
});

test('the sort control offers last used, newest and name, and marks the current order', async () => {
  await withChromeModule(MODULE, (mod, { t, setLang }) => {
    for (const lang of LANGS) {
      setLang(lang);
      const html = render(mod, ready(ROOMS), { sort: 'name' });
      const options = [...html.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)<\/option>/g)]
        .map(([, value, attributes, label]) => ({ value, selected: attributes.includes('selected'), label }));
      assert.deepEqual(options, [
        { value: 'recent', selected: false, label: t('workspace.sort.recent') },
        { value: 'created', selected: false, label: t('workspace.sort.created') },
        { value: 'name', selected: true, label: t('workspace.sort.name') },
      ], lang);
      assert.match(html, new RegExp(`<select[^>]*aria-label="${t('workspace.sort')}"`), `${lang}: the sort control keeps its name when the label is hidden on phones`);
      assert.ok(html.includes(`placeholder="${t('workspace.search')}"`), lang);
    }
    setLang('en');
  });
});

test('the list follows the chosen order', async () => {
  await withChromeModule(MODULE, (mod) => {
    const order = (sort) => cardsOf(render(mod, ready(ROOMS), { sort }))
      .map((card) => ROOMS.find((room) => card.includes(`href="${room.link}"`)).code);
    assert.deepEqual(order('recent'), [BOARD.code, LOCKED.code, POKER.code, UNTOUCHED.code]);
    assert.deepEqual(order('created'), [LOCKED.code, BOARD.code, POKER.code, UNTOUCHED.code]);
  });
});

test('the page puts the create action and the workspace links in the masthead', async () => {
  await withChromeModule(MODULE, ({ default: Workspace, WORKSPACE_LINKS }, { t, setLang }) => {
    assert.deepEqual(WORKSPACE_LINKS.map(({ href }) => href), ['/planning-poker', '/agile-scrum']);
    for (const lang of LANGS) {
      setLang(lang);
      const createAction = React.createElement('button', { type: 'button', className: 'probe-create' }, 'probe');
      const html = renderToStaticMarkup(React.createElement(Workspace, { createAction }));
      const header = html.match(/<header class="rb-landing__masthead"[\s\S]*?<\/header>/)[0];
      assert.ok(header.includes('class="probe-create"'), lang);
      assert.ok(header.includes(`<a href="/planning-poker">${t('poker.title')}</a>`), lang);
      assert.ok(header.includes(`<a href="/agile-scrum">${t('agileGuide.nav.guide')}</a>`), lang);
      assert.match(html, new RegExp(`<h1[^>]*>${t('workspace.title')}`), lang);
      assert.match(html, /aria-busy="true"/, `${lang}: the list starts loading`);
    }
    setLang('en');
  });
});
