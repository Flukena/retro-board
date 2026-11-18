import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { HostIFrame, createHostDocument } from '../../test-support/host-document.js';
import { SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE } from '../account/signed-in-hint.js';
import { HOME_HINT_CLASS } from './home-view.js';

const MODULE = '/src/client/app/HomeRoute.jsx';

// The first render has no account answer yet, so only this browser's hint decides the page.
async function renderFirstPaint(hint) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => (key === SIGNED_IN_HINT_KEY ? hint : null), setItem() {}, removeItem() {} },
  });
  try {
    let html = '';
    await withChromeModule(MODULE, ({ default: HomeRoute }, { setLang }) => {
      setLang('en');
      html = renderToStaticMarkup(React.createElement(HomeRoute));
    });
    return html;
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

test('a hinted visitor gets the workspace skeleton and never the guest landing', async () => {
  const html = await renderFirstPaint(SIGNED_IN_HINT_VALUE);
  assert.match(html, /class="rb-workspace"/);
  assert.match(html, /aria-busy="true"/, 'the list is still loading');
  const trigger = html.match(/<button\b[^>]*rb-workspace-create__trigger[^>]*>/)?.[0];
  assert.ok(trigger, 'the create menu fills the masthead action slot');
  assert.match(trigger, /\sdisabled=""/, 'creating waits for the account answer');
  assert.doesNotMatch(html, /rb-landing__page/);
  assert.equal(html.match(/<main\b/g).length, 1, 'one main landmark');
});

test('a visitor without the hint gets the guest landing first', async () => {
  for (const hint of [null, '0']) {
    const html = await renderFirstPaint(hint);
    assert.match(html, /class="rb-landing__page"/, String(hint));
    assert.doesNotMatch(html, /rb-workspace/, String(hint));
    assert.equal(html.match(/<main\b/g).length, 1, 'one main landmark');
  }
});

// The real views need a full browser DOM. Here they are plain roots carrying their class, so the mount
// test exercises only HomeRoute's own work: choosing the view, wiring the create menu and releasing the
// head script's mark. Each stub renders the masthead action it is given, says whether the session it got
// may be offered a locked board, and whether it was told that creating is allowed.
const VIEW_STUBS = Object.freeze({
  './Landing.jsx': 'rb-landing__page', '../workspace/Workspace.jsx': 'rb-workspace', '../workspace/CreateMenu.jsx': 'create-menu',
});
const STUB_PREFIX = '\0home-view-stub:';
const LOCKED_OFFER_MODULE = '/src/client/room-lock/create-locked-room-controller.js';
const OFFERS_LOCKED_ATTRIBUTE = 'data-offers-locked';
const CAN_CREATE_ATTRIBUTE = 'data-can-create';
const stubHomeViews = () => ({
  name: 'stub-home-views',
  enforce: 'pre',
  resolveId(id, importer) {
    return importer?.endsWith(MODULE) && Object.hasOwn(VIEW_STUBS, id) ? `${STUB_PREFIX}${VIEW_STUBS[id]}` : null;
  },
  load(id) {
    if (!id.startsWith(STUB_PREFIX)) return null;
    const className = JSON.stringify(id.slice(STUB_PREFIX.length));
    return [
      "import React from 'react';",
      `import { canOfferLockedRoom } from '${LOCKED_OFFER_MODULE}';`,
      'export default function View({ createAction = null, session, canCreate }) {',
      `  const marks = { '${OFFERS_LOCKED_ATTRIBUTE}': String(canOfferLockedRoom(session)), '${CAN_CREATE_ATTRIBUTE}': String(canCreate) };`,
      `  return React.createElement('div', { className: ${className}, ...marks }, createAction);`,
      '}',
      '',
    ].join('\n');
  },
});

const PAGE_LOCATION = Object.freeze({ origin: 'http://localhost:5173', hostname: 'localhost', protocol: 'http:', pathname: '/', search: '' });
const GLOBALS = Object.freeze(['window', 'document', 'localStorage', 'fetch']);

const pendingFetch = () => new Promise(() => {});

// A hinted page as public/home-hint.js leaves it: <html> marked and the hint stored; by default the account request stays open.
function installHintedPage(context, { fetch = pendingFetch } = {}) {
  const saved = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  context.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const values = new Map([[SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE]]);
  const document = createHostDocument();
  document.documentElement.classList.add(HOME_HINT_CLASS);
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define('window', { HTMLIFrameElement: HostIFrame, location: PAGE_LOCATION });
  define('document', document);
  define('localStorage', {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key),
  });
  define('fetch', fetch);
  return { document, values };
}

const viewOf = (container) => container.firstChild?.attributes.get('class');
const isMarked = (document) => document.documentElement.classList.contains(HOME_HINT_CLASS);

test('mounting releases the head script mark, and signing out shows the landing at once', async (context) => {
  const { document, values } = installHintedPage(context);
  await withChromeModule(MODULE, async ({ default: HomeRoute }, _i18n, { load }) => {
    const { accountSessionStore } = await load('/src/client/account/account-session-store.js');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(React.createElement(HomeRoute)));
      assert.equal(viewOf(container), 'rb-workspace', 'hinted, with the account still loading');
      assert.equal(container.firstChild.attributes.get(CAN_CREATE_ATTRIBUTE), 'false', 'no create before the account answer');
      assert.equal(isMarked(document), false, 'mounted, so the landing is no longer hidden');
      flushSync(() => accountSessionStore.markSignedOut());
      assert.equal(viewOf(container), 'rb-landing__page', 'signing out shows the landing without a reload');
      assert.equal(isMarked(document), false, 'so the landing is visible at once, not after the CSS fallback delay');
      assert.equal(values.has(SIGNED_IN_HINT_KEY), false, 'and the next visit is a guest visit');
    } finally {
      flushSync(() => root.unmount());
    }
  }, { plugins: [stubHomeViews()] });
});

test('mounting releases the mark even when the first view is already the landing', async (context) => {
  const { document, values } = installHintedPage(context);
  await withChromeModule(MODULE, async ({ default: HomeRoute }, _i18n, { load }) => {
    const { accountSessionStore } = await load('/src/client/account/account-session-store.js');
    accountSessionStore.markSignedOut();
    values.set(SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(React.createElement(HomeRoute)));
      assert.equal(viewOf(container), 'rb-landing__page', 'a stale hint never outranks a known signed-out account');
      assert.equal(isMarked(document), false);
    } finally {
      flushSync(() => root.unmount());
    }
  }, { plugins: [stubHomeViews()] });
});

const HTTP_OK = 200;
const ENTITLED_ACCOUNT = Object.freeze({ name: 'Ada', plan: 'free', entitlements: Object.freeze({ canCreateLockedRoom: true }) });
const answerSignedIn = async () => new Response(JSON.stringify(ENTITLED_ACCOUNT), { status: HTTP_OK });

test('the create menu gets the account session, so an entitled account is offered a locked board', async (context) => {
  const { document } = installHintedPage(context, { fetch: answerSignedIn });
  await withChromeModule(MODULE, async ({ default: HomeRoute }, _i18n, { load }) => {
    const { accountSessionStore } = await load('/src/client/account/account-session-store.js');
    await accountSessionStore.load();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(React.createElement(HomeRoute)));
      assert.equal(viewOf(container), 'rb-workspace');
      const menu = container.firstChild.firstChild;
      assert.equal(menu?.attributes.get('class'), 'create-menu', 'the create menu fills the masthead action slot');
      assert.equal(menu.attributes.get(OFFERS_LOCKED_ATTRIBUTE), 'true');
      assert.equal(container.firstChild.attributes.get(CAN_CREATE_ATTRIBUTE), 'true', 'a confirmed account may create');
    } finally {
      flushSync(() => root.unmount());
    }
  }, { plugins: [stubHomeViews()] });
});

const HTTP_UNAVAILABLE = 503;
const answerUnavailable = async () => new Response(null, { status: HTTP_UNAVAILABLE });

test('an unavailable relay keeps a hinted visitor on the workspace without offering to create', async (context) => {
  const { document } = installHintedPage(context, { fetch: answerUnavailable });
  await withChromeModule(MODULE, async ({ default: HomeRoute }, _i18n, { load }) => {
    const { accountSessionStore } = await load('/src/client/account/account-session-store.js');
    await accountSessionStore.load();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(React.createElement(HomeRoute)));
      assert.equal(viewOf(container), 'rb-workspace');
      assert.equal(container.firstChild.attributes.get(CAN_CREATE_ATTRIBUTE), 'false');
    } finally {
      flushSync(() => root.unmount());
    }
  }, { plugins: [stubHomeViews()] });
});
