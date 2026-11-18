import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { AUTH_ERROR_CODES } from '../../domain/auth-errors.js';

const ACCOUNT = { name: 'Ada', email: 'ada@example.com', plan: 'pro' };
const HREF = 'https://retroroom.party/yjs/api/auth/google/start?return=x';
const noop = () => {};
const render = ({ AccountMenuView }, props) => renderToStaticMarkup(
  React.createElement(AccountMenuView, { href: HREF, inApp: false, onCopyLink: noop, onRetry: noop, ...props }),
);

test('AccountMenu renders nothing when disabled', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', (mod) => {
    assert.equal(render(mod, { session: { status: 'disabled' } }), '');
    assert.equal(render(mod, { session: { status: null } }), '');
  });
});

test('AccountMenu shows the sign-in link when signed out', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', (mod, { t, setLang }) => {
    setLang('en');
    const html = render(mod, { session: { status: 'signed-out' } });
    assert.ok(html.includes(`href="${HREF.replace('&', '&amp;')}"`));
    assert.ok(html.includes(t('account.signIn')));
  });
});

test('AccountMenu shows in-app notice instead of the sign-in link inside LINE', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', (mod, { t, setLang }) => {
    setLang('en');
    const html = render(mod, { session: { status: 'signed-out' }, inApp: true });
    assert.ok(html.includes(t('account.inAppBrowser')));
    assert.ok(html.includes(t('account.copyLink')));
    assert.ok(!html.includes('href='));
    assert.ok(!html.includes(t('account.signIn')));
  });
});

test('AccountMenu offers a retry when the account cannot be loaded', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', (mod, { t, setLang }) => {
    setLang('en');
    assert.ok(render(mod, { session: { status: 'unavailable' } }).includes(t('account.retry')));
  });
});

test('AccountMenu signed in shows name and plan, and lists the actions only when open', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', (mod, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const session = { status: 'signed-in', account: ACCOUNT };
      const closed = render(mod, { session });
      assert.ok(closed.includes('Ada') && closed.includes(t('account.plan.pro')));
      assert.ok(!closed.includes(t('account.signOut')));
      const open = render(mod, { session, open: true, myBoardsHref: '/' });
      for (const key of ['account.myBoards', 'account.signOut', 'account.signOutAll', 'account.delete']) assert.ok(open.includes(t(key)), key);
      assert.ok(open.includes('ada@example.com'));
      assert.ok(!open.includes(t('account.deleteConfirm')));
      assert.ok(render(mod, { session, confirmingDelete: true }).includes(t('account.deleteConfirm')));
      // My boards is a page now, not a dialog over the current one.
      assert.ok(!open.includes('role="dialog"'));
    }
  });
});

const renderSignedIn = ({ SignedInMenu }, props) => renderToStaticMarkup(React.createElement(SignedInMenu, {
  account: ACCOUNT, open: true, onToggle: noop, onSignOut: noop, onSignOutAll: noop, onAskDelete: noop, ...props,
}));

test('SignedInMenu links My boards to the home page', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', (mod, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderSignedIn(mod, { myBoardsHref: '/' });
      const link = html.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
      assert.ok(link, `${lang}: a link, so it navigates like one`);
      assert.match(link[0], /\bhref="\/"/, lang);
      assert.ok(link[1].includes(t('account.myBoards')), lang);
    }
  });
});

test('SignedInMenu has no My boards item where the page already is My boards', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', (mod, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderSignedIn(mod, { myBoardsHref: null });
      assert.ok(!html.includes(t('account.myBoards')), lang);
      assert.doesNotMatch(html, /<a\b/, lang);
      for (const key of ['account.signOut', 'account.signOutAll', 'account.delete']) assert.ok(html.includes(t(key)), `${lang}: ${key}`);
    }
  });
});

test('every account.* key exists in th, en and every on-demand locale', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', async (_mod, { t, setLang, LANGUAGE_OPTIONS }) => {
    const keys = ['signIn', 'signOut', 'signOutAll', 'delete', 'deleteConfirm', 'plan.free', 'plan.pro', 'inAppBrowser',
      'copyLink', 'copied', 'retry', 'menu', 'failed', 'myBoards', ...AUTH_ERROR_CODES.map((code) => `error.${code}`)].map((k) => `account.${k}`);
    for (const { code } of LANGUAGE_OPTIONS) {
      await setLang(code);
      for (const key of keys) assert.notEqual(t(key), key, `${code}: ${key}`);
    }
  });
});

test('AccountFrame renders no wrapper or toast for disabled and loading, but does when signed out', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', ({ AccountFrame }) => {
    const frame = (status) => renderToStaticMarkup(
      React.createElement(AccountFrame, { status, toast: { msg: 'boom', type: 'warn' }, onCloseToast: noop }, 'child'),
    );
    assert.equal(frame('disabled'), '');
    assert.equal(frame(null), '');
    for (const status of ['signed-out', 'signed-in', 'unavailable']) {
      const html = frame(status);
      assert.ok(html.includes('rb-account') && html.includes('child') && html.includes('boom'), status);
    }
  });
});

test('AccountMenu labels the trigger with the email when Google gave no name', async () => {
  await withChromeModule('/src/client/account/AccountMenu.jsx', (mod, { setLang }) => {
    setLang('en');
    const html = render(mod, { session: { status: 'signed-in', account: { ...ACCOUNT, name: '' } } });
    assert.match(html, /<span class="rb-account__name">ada@example\.com<\/span>/);
  });
});

test('account styles take font sizes from theme tokens', () => {
  const css = readFileSync(new URL('./account.css', import.meta.url), 'utf8');
  const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(sizes.length > 0);
  for (const size of sizes) assert.match(size, /^var\(--[a-z-]+\)$/, size);
});
