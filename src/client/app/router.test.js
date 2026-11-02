import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forgetRecent,
  isBoardCreatedByMe,
  ROOM_KIND,
  loadRecents,
  markBoardCreated,
  recentBoardName,
  rememberRecent,
} from './router.js';

const installStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
    },
  });
  return values;
};

test('malformed recent storage is normalized to an empty list', () => {
  installStorage({ rb_recents: '"not-an-array"' });
  assert.deepEqual(loadRecents(), []);

  installStorage({
    rb_recents: JSON.stringify([
      null,
      { code: '../bad', token: null },
      { code: 'Room1234', token: 'valid_token', name: 42, visitedAt: -1 },
    ]),
  });
  assert.deepEqual(loadRecents(), [{
    code: 'Room1234', token: 'valid_token', name: '', visitedAt: 0, kind: ROOM_KIND.BOARD,
  }]);
});

test('a recent remembers whether it is a poker room; older or unknown entries reopen as boards', () => {
  installStorage({
    rb_recents: JSON.stringify([
      { code: 'Legacy12', token: 'valid_token', name: 'old' },
      { code: 'Weird123', token: 'valid_token', kind: 'spreadsheet' },
    ]),
  });
  rememberRecent('Poker123', '', 'valid_token', ROOM_KIND.POKER);
  rememberRecent('Poker123', undefined, 'valid_token', ROOM_KIND.POKER);
  assert.deepEqual(loadRecents().map((r) => [r.code, r.kind]), [
    ['Poker123', ROOM_KIND.POKER],
    ['Legacy12', ROOM_KIND.BOARD],
    ['Weird123', ROOM_KIND.BOARD],
  ]);
});

test('refreshing a recent preserves its existing board name', () => {
  installStorage();
  rememberRecent('Room1234', '  Planning retro  ', 'valid_token');
  rememberRecent('Room1234', undefined, 'valid_token');
  assert.equal(loadRecents()[0].name, 'Planning retro');

  forgetRecent('Room1234', 'valid_token');
  assert.deepEqual(loadRecents(), []);
});

test('malformed creator storage is repaired by the next create marker', () => {
  installStorage({ rb_created_boards: '{}' });
  markBoardCreated('Room1234', 'valid_token');
  assert.equal(isBoardCreatedByMe('Room1234', 'valid_token'), true);
});

test('legal paths route to the legal page instead of the landing', async () => {
  const { parseRoute } = await import('./router.js');
  const original = globalThis.window;
  try {
    for (const [pathname, page] of [['/privacy', 'privacy'], ['/terms/', 'terms']]) {
      globalThis.window = { location: { pathname, hash: '' } };
      assert.deepEqual(parseRoute(), { kind: 'legal', page });
    }
    globalThis.window = { location: { pathname: '/', hash: '' } };
    assert.deepEqual(parseRoute(), { kind: 'landing' });
  } finally {
    globalThis.window = original;
  }
});

test('recent board name is found by code and token', () => {
  installStorage();
  rememberRecent('Room1234', '  Sprint 42  ', 'abcdefghijklmnop');
  assert.equal(recentBoardName('Room1234', 'abcdefghijklmnop'), 'Sprint 42');
  assert.equal(recentBoardName('Room1234', 'zzzzzzzzzzzzzzzz'), null);
  assert.equal(recentBoardName('Other123', 'abcdefghijklmnop'), null);
});

test('template guides route by slug, and unknown paths route to the not-found page', async () => {
  const { parseRoute } = await import('./router.js');
  const original = globalThis.window;
  try {
    const route = (pathname) => { globalThis.window = { location: { pathname, hash: '' } }; return parseRoute(); };
    assert.deepEqual(route('/templates/mad-sad-glad'), { kind: 'template', slug: 'mad-sad-glad' });
    assert.deepEqual(route('/templates/4ls-retrospective/'), { kind: 'template', slug: '4ls-retrospective' });
    for (const pathname of ['/templates/unknown', '/templates/', '/nope', '/b/x', '/b/Room1234/extra']) {
      assert.deepEqual(route(pathname), { kind: 'notFound' }, pathname);
    }
    assert.deepEqual(route('/index.html'), { kind: 'landing' });
  } finally {
    globalThis.window = original;
  }
});

test('content pages under /th route in Thai; boards and the Public Wall have no Thai prefix', async () => {
  const { parseRoute } = await import('./router.js');
  const original = globalThis.window;
  try {
    const route = (pathname) => { globalThis.window = { location: { pathname, hash: '' } }; return parseRoute(); };
    assert.deepEqual(route('/th'), { kind: 'landing', lang: 'th' });
    assert.deepEqual(route('/th/'), { kind: 'landing', lang: 'th' });
    assert.deepEqual(route('/th/templates/retro-loop'), { kind: 'template', slug: 'retro-loop', lang: 'th' });
    assert.deepEqual(route('/th/privacy'), { kind: 'legal', page: 'privacy', lang: 'th' });
    for (const pathname of ['/th/nope', '/th/templates/unknown', '/th/b/Room1234', '/th/public']) {
      assert.deepEqual(route(pathname), { kind: 'notFound' }, pathname);
    }
    assert.deepEqual(route('/thai'), { kind: 'notFound' });
    assert.deepEqual(route('/public'), { kind: 'public' });
    assert.equal(route('/b/Room1234').kind, 'board');
  } finally {
    globalThis.window = original;
  }
});

test('poker rooms route by /p/ with the capability read from the fragment', async () => {
  const { parseRoute, ROOM_KIND } = await import('./router.js');
  const original = globalThis.window;
  try {
    const route = (pathname, hash = '') => { globalThis.window = { location: { pathname, hash } }; return parseRoute(); };
    assert.deepEqual(route('/p/Room1234', '#abcdefghijklmnop'), { kind: ROOM_KIND.POKER, code: 'Room1234', token: 'abcdefghijklmnop' });
    assert.deepEqual(route('/p/Room1234/'), { kind: ROOM_KIND.POKER, code: 'Room1234', token: null });
    for (const pathname of ['/p/x', '/p/Room1234/extra', '/th/p/Room1234']) {
      assert.deepEqual(route(pathname), { kind: 'notFound' }, pathname);
    }
  } finally {
    globalThis.window = original;
  }
});

test('the Planning Poker guide routes in English and Thai', async () => {
  const { parseRoute } = await import('./router.js');
  const original = globalThis.window;
  try {
    const route = (pathname) => { globalThis.window = { location: { pathname, hash: '' } }; return parseRoute(); };
    assert.deepEqual(route('/planning-poker'), { kind: 'pokerGuide' });
    assert.deepEqual(route('/planning-poker/'), { kind: 'pokerGuide' });
    assert.deepEqual(route('/th/planning-poker'), { kind: 'pokerGuide', lang: 'th' });
    assert.deepEqual(route('/planning-pokers'), { kind: 'notFound' });
  } finally {
    globalThis.window = original;
  }
});

test('share links keep the room kind path and put the token in the fragment', async () => {
  const { buildBoardUrl, ROOM_KIND } = await import('./router.js');
  const original = globalThis.window;
  try {
    globalThis.window = { location: { origin: 'https://retroroom.party' } };
    assert.equal(buildBoardUrl('Room1234', 'abcdefghijklmnop'), 'https://retroroom.party/b/Room1234#abcdefghijklmnop');
    assert.equal(buildBoardUrl('Room1234', 'abcdefghijklmnop', ROOM_KIND.POKER), 'https://retroroom.party/p/Room1234#abcdefghijklmnop');
  } finally {
    globalThis.window = original;
  }
});
