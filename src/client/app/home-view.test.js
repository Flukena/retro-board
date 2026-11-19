import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ACCOUNT_STATUS } from '../account/account-api.js';
import { SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE } from '../account/signed-in-hint.js';
import { LANGUAGE_OPTIONS } from '../ui/i18n.js';
import { TOKENS } from '../ui/theme.js';
import { AGILE_GUIDE_PATH, PLANNING_POKER_PATH } from '../seo/seo-pages.js';
import { TEMPLATE_PATH_PREFIX } from '../templates/starter-formats.js';
import { HOME_HINT_CLASS, HOME_VIEW, homeViewFor } from './home-view.js';
import { isLandingPath } from './router.js';

const readRepoFile = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const HEAD_SCRIPT_PATH = 'public/home-hint.js';
const HEAD_SCRIPT = readRepoFile(HEAD_SCRIPT_PATH);
const HOME_CSS = readFileSync(new URL('./home.css', import.meta.url), 'utf8');
const REVEAL_DELAY_TOKEN = '--home-hint-reveal-delay';
const WORKSPACE_GROUND_TOKEN = '--workspace-ground';

const session = (status) => ({ status });

test('homeViewFor trusts the hint only until the account says otherwise', () => {
  const cases = [
    { name: 'pending, hinted', hinted: true, session: null, view: HOME_VIEW.WORKSPACE },
    { name: 'pending, no hint', hinted: false, session: null, view: HOME_VIEW.LANDING },
    { name: 'signed in, hinted', hinted: true, session: session(ACCOUNT_STATUS.SIGNED_IN), view: HOME_VIEW.WORKSPACE },
    { name: 'signed in, no hint', hinted: false, session: session(ACCOUNT_STATUS.SIGNED_IN), view: HOME_VIEW.WORKSPACE },
    { name: 'signed out, hinted', hinted: true, session: session(ACCOUNT_STATUS.SIGNED_OUT), view: HOME_VIEW.LANDING },
    { name: 'signed out, no hint', hinted: false, session: session(ACCOUNT_STATUS.SIGNED_OUT), view: HOME_VIEW.LANDING },
    { name: 'disabled, hinted', hinted: true, session: session(ACCOUNT_STATUS.DISABLED), view: HOME_VIEW.LANDING },
    { name: 'disabled, no hint', hinted: false, session: session(ACCOUNT_STATUS.DISABLED), view: HOME_VIEW.LANDING },
    { name: 'unavailable, hinted', hinted: true, session: session(ACCOUNT_STATUS.UNAVAILABLE), view: HOME_VIEW.WORKSPACE },
    { name: 'unavailable, no hint', hinted: false, session: session(ACCOUNT_STATUS.UNAVAILABLE), view: HOME_VIEW.LANDING },
  ];
  for (const { name, hinted, session: current, view } of cases) {
    assert.equal(homeViewFor({ hinted, session: current }), view, name);
  }
  assert.deepEqual({ ...HOME_VIEW }, { LANDING: 'landing', WORKSPACE: 'workspace' });
});

test('the head script and the module agree', () => {
  for (const value of [SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE, HOME_HINT_CLASS]) {
    assert.ok(HEAD_SCRIPT.includes(`'${value}'`), value);
  }
  assert.equal(HOME_HINT_CLASS, 'rb-home-hinted');
  assert.match(HEAD_SCRIPT, /try\s*\{[\s\S]*localStorage[\s\S]*\}\s*catch/);
  assert.doesNotMatch(HEAD_SCRIPT, /\b(?:import|export)\b/, 'a classic script, so it runs before first paint');
});

// Runs the real head script against a fake page and records every storage and class call it makes.
function runHeadScript({ pathname, hint = null, storageThrows = false, storageGetterThrows = false }) {
  const calls = [];
  const storage = {
    getItem(key) {
      calls.push(`getItem:${key}`);
      if (storageThrows) throw new Error('storage blocked');
      return key === SIGNED_IN_HINT_KEY ? hint : null;
    },
    setItem(key) { calls.push(`setItem:${key}`); },
    removeItem(key) { calls.push(`removeItem:${key}`); },
  };
  const classList = {
    add(name) { calls.push(`add:${name}`); },
    remove(name) { calls.push(`remove:${name}`); },
    toggle(name) { calls.push(`toggle:${name}`); },
  };
  const page = { location: { pathname }, document: { documentElement: { classList } } };
  Object.defineProperty(page, 'localStorage', {
    get() {
      if (storageGetterThrows) throw new Error('SecurityError');
      return storage;
    },
  });
  runInNewContext(HEAD_SCRIPT, page, { filename: HEAD_SCRIPT_PATH });
  return calls;
}

const R2_PATHS = Object.freeze([
  '/', '/index.html', '/en', '/en/', '/th/index.html', '/agile-guide', '/en/agile-guide',
  `${TEMPLATE_PATH_PREFIX}mad-sad-glad`, '/b/Ab3dEf7h', '/p/Pq9rSt2u',
]);
const REAL_PAGE_PATHS = Object.freeze([
  AGILE_GUIDE_PATH, `${AGILE_GUIDE_PATH}/`, PLANNING_POKER_PATH, '/public', '/privacy',
  '/thai', '/index.htm', '/index.html/', '/th/index.html/', '//',
]);
// Every language's home, so a new language breaks this test instead of silently losing the guard.
const LANGUAGE_PATHS = LANGUAGE_OPTIONS.flatMap(({ code }) => [
  `/${code}`, `/${code}/`, `/${code}/index.html`, `/${code}${AGILE_GUIDE_PATH}`, `/${code}${TEMPLATE_PATH_PREFIX}mad-sad-glad`,
]);
const HINT_VALUES = Object.freeze([SIGNED_IN_HINT_VALUE, '0', 'true', '', null]);

test('the head script marks only hinted landing paths, exactly as isLandingPath reads them', () => {
  const paths = [...new Set([...R2_PATHS, ...REAL_PAGE_PATHS, ...LANGUAGE_PATHS])];
  const mismatches = [];
  for (const pathname of paths) {
    for (const hint of HINT_VALUES) {
      const calls = runHeadScript({ pathname, hint });
      const expected = isLandingPath(pathname) && hint === SIGNED_IN_HINT_VALUE;
      const added = calls.filter((call) => call.startsWith('add:'));
      if (added.length !== Number(expected) || (expected && added[0] !== `add:${HOME_HINT_CLASS}`)) {
        mismatches.push(`${pathname} hint=${hint}: ${calls.join(',')}`);
      }
      const unexpected = calls.filter((call) => call !== `getItem:${SIGNED_IN_HINT_KEY}` && call !== `add:${HOME_HINT_CLASS}`);
      if (unexpected.length) mismatches.push(`${pathname} hint=${hint}: unexpected ${unexpected.join(',')}`);
    }
  }
  assert.deepEqual(mismatches, []);
  // The table must hold both outcomes, or agreement proves nothing.
  for (const pathname of ['/', '/index.html', '/th', '/th/', '/th/index.html', '/ja']) assert.ok(isLandingPath(pathname), pathname);
  for (const pathname of ['/en', '/en/', '/agile-guide', AGILE_GUIDE_PATH, '/b/Ab3dEf7h', '/p/Pq9rSt2u']) {
    assert.ok(!isLandingPath(pathname), pathname);
  }
});

test('blocked storage leaves the page unmarked and throws nothing', () => {
  for (const blocked of [{ storageThrows: true }, { storageGetterThrows: true }]) {
    for (const pathname of ['/', '/th']) {
      let calls;
      assert.doesNotThrow(() => { calls = runHeadScript({ pathname, hint: SIGNED_IN_HINT_VALUE, ...blocked }); });
      assert.deepEqual(calls.filter((call) => call.startsWith('add:')), [], `${pathname} ${JSON.stringify(blocked)}`);
    }
  }
});

test('index.html loads /home-hint.js in head before the stylesheet', () => {
  const html = readRepoFile('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const tag = '<script src="/home-hint.js"></script>';
  const at = head.indexOf(tag);
  assert.ok(at >= 0, 'a plain blocking script tag in <head>');
  assert.ok(at < head.indexOf('rel="stylesheet"'), 'before the font stylesheet');
  assert.equal(html.split('home-hint.js').length - 1, 1, 'loaded once');
});

test('home.css hides the landing only for hinted pages and reveals it after the fallback delay', () => {
  const css = HOME_CSS.replaceAll(/\s+/g, ' ');
  assert.ok(css.includes(`:root { ${REVEAL_DELAY_TOKEN}: 3s; }`));
  const rule = css.match(/\.rb-home-hinted \.rb-landing__page \{([^}]*)\}/);
  assert.ok(rule, 'one rule scoped to the hinted landing');
  assert.match(rule[1], /visibility: hidden/);
  assert.match(rule[1], new RegExp(`animation: [^;]*var\\(${REVEAL_DELAY_TOKEN}\\)`));
  const name = rule[1].match(/animation: (rb-[\w-]+)/)?.[1];
  assert.ok(name, 'a named reveal animation');
  assert.match(css, new RegExp(`@keyframes ${name} \\{[^}]*visibility: visible`));
  assert.match(rule[1], /forwards/, 'the landing stays revealed once the delay passes');
  // Only the guest landing hides: the workspace root and guide pages are untouched.
  assert.equal(css.match(/visibility: hidden/g).length, 1);
});

test('a hinted page paints the workspace ground with !important, so the inline body background theme.js writes cannot make it step to white', () => {
  const css = HOME_CSS.replaceAll(/\s+/g, ' ');
  const rule = css.match(/\.rb-home-hinted body \{([^}]*)\}/);
  assert.ok(rule, 'one rule for the hinted page body');
  assert.match(rule[1], new RegExp(`background: var\\(${WORKSPACE_GROUND_TOKEN}\\) !important;`));
  // The prerendered pages carry every theme token inline, so the ground resolves before theme.js runs.
  for (const [mode, tokens] of Object.entries(TOKENS)) assert.ok(tokens[WORKSPACE_GROUND_TOKEN], mode);
});

test('the CSS fallback delay matches the theme token', () => {
  // home.css declares the delay itself because theme.js, which applies every token, may be the bundle that failed.
  const declared = HOME_CSS.match(new RegExp(`:root\\s*\\{\\s*${REVEAL_DELAY_TOKEN}:\\s*([^;]+);`))?.[1];
  assert.ok(declared);
  for (const [mode, tokens] of Object.entries(TOKENS)) assert.equal(tokens[REVEAL_DELAY_TOKEN], declared, mode);
});
