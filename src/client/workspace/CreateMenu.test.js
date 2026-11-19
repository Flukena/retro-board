import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const MODULE = '/src/client/workspace/CreateMenu.jsx';
const LANGS = Object.freeze(['th', 'en']);
const DISPLAY_NAME_LIMIT = 120;
const FORMAT_CHIP_COUNT = 4;
const signedIn = (canCreateLockedRoom) => ({
  status: 'signed-in', account: { entitlements: { canCreateLockedRoom } },
});
const noop = () => {};

const render = ({ CreateMenuView, CREATE_PANEL }, props = {}) => renderToStaticMarkup(React.createElement(CreateMenuView, {
  open: false, panel: CREATE_PANEL.NONE, session: signedIn(false), creating: false, createError: null,
  onToggle: noop, onPanel: noop, onCreate: noop, onStartFormat: noop, onCreatePoker: noop, onCreateLocked: noop, ...props,
}));
const menuItems = (html) => [...html.matchAll(/<button\b[^>]*role="menuitem"[^>]*>([\s\S]*?)<\/button>/g)].map(([, inner]) => inner);

const forEachLang = (check) => withChromeModule(MODULE, async (module, i18n) => {
  for (const lang of LANGS) {
    i18n.setLang(lang);
    await check(module, i18n.t, lang);
  }
});

test('closed menu renders the workspace.create button with aria-expanded false', async () => {
  await forEachLang((module, t) => {
    const html = render(module);
    const trigger = html.match(/<button\b[^>]*aria-haspopup="menu"[^>]*>/)?.[0] ?? '';
    assert.match(trigger, /aria-expanded="false"/);
    assert.ok(trigger.includes(`aria-label="${t('workspace.create')}"`), trigger);
    assert.ok(html.includes(t('workspace.create')));
    assert.equal(menuItems(html).length, 0);
    assert.doesNotMatch(html, /role="menu"/);
  });
});

test('open menu lists blank, template and poker, and locked only when the account may create locked rooms', async () => {
  await forEachLang((module, t) => {
    const base = ['workspace.create.new', 'workspace.create.template', 'workspace.create.poker'].map(t);
    const withoutLock = menuItems(render(module, { open: true, session: signedIn(false) }));
    assert.equal(withoutLock.length, base.length);
    base.forEach((label, index) => assert.ok(withoutLock[index].includes(label), label));
    const withLock = menuItems(render(module, { open: true, session: signedIn(true) }));
    assert.equal(withLock.length, base.length + 1);
    assert.ok(withLock.some((inner) => inner.includes(t('workspace.create.locked'))));
    assert.match(render(module, { open: true }), /aria-expanded="true"/);
    const signedOut = menuItems(render(module, { open: true, session: { status: 'signed-out' } }));
    assert.ok(!signedOut.some((inner) => inner.includes(t('workspace.create.locked'))));
  });
});

test('the NEW panel shows an optional name field limited to DISPLAY_NAME_MAX_LENGTH and a submit button', async () => {
  await forEachLang((module, t) => {
    const html = render(module, { open: true, panel: module.CREATE_PANEL.NEW });
    const input = html.match(/<input\b[^>]*>/)?.[0] ?? '';
    assert.match(input, new RegExp(`maxLength="${DISPLAY_NAME_LIMIT}"`));
    assert.ok(input.includes(`aria-label="${t('workspace.create.name')}"`), input);
    assert.match(html, new RegExp(`<button\\b[^>]*type="submit"[^>]*>[^<]*${t('workspace.create.submit')}`));
  });
});

test('the TEMPLATE panel renders the four format chips', async () => {
  await forEachLang((module) => {
    const html = render(module, { open: true, panel: module.CREATE_PANEL.TEMPLATE });
    assert.equal(html.match(/class="rb-landing__chip"/g)?.length, FORMAT_CHIP_COUNT);
  });
});

test('the LOCKED panel renders the password form', async () => {
  await forEachLang((module) => {
    const html = render(module, { open: true, panel: module.CREATE_PANEL.LOCKED, session: signedIn(true) });
    assert.equal(html.match(/type="password"/g)?.length, 2);
  });
});

test('a create error renders CreateBoardError copy inside the menu', async () => {
  await forEachLang((module, t) => {
    const html = render(module, { open: true, createError: { code: 'unavailable' } });
    const menu = html.match(/role="menu"[\s\S]*$/)?.[0] ?? '';
    assert.ok(menu.includes(`role="alert"`) && menu.includes(t('landing.create.error.unavailable')), menu);
    assert.doesNotMatch(render(module, { open: true }), /role="alert"/);
  });
});

// A create sent before the relay confirms the account would make a guest room, so a hinted page waits for the answer.
test('the create trigger is disabled and the menu stays shut until the account is confirmed signed in', async () => {
  const unconfirmed = [null, { status: 'unavailable' }, { status: 'signed-out' }, { status: 'disabled' }];
  await forEachLang((module) => {
    for (const session of unconfirmed) {
      const html = render(module, { open: true, session });
      const trigger = html.match(/<button\b[^>]*aria-haspopup="menu"[^>]*>/)?.[0] ?? '';
      assert.match(trigger, /\sdisabled=""/, JSON.stringify(session));
      assert.match(trigger, /aria-expanded="false"/, JSON.stringify(session));
      assert.doesNotMatch(html, /role="menu"/, JSON.stringify(session));
    }
    const confirmed = render(module, { open: true, session: signedIn(false) });
    assert.doesNotMatch(confirmed.match(/<button\b[^>]*aria-haspopup="menu"[^>]*>/)[0], /\sdisabled=""/);
    assert.match(confirmed, /role="menu"/);
  });
});

test('creating disables every way to start a board', async () => {
  await forEachLang((module) => {
    const html = render(module, { open: true, creating: true });
    const items = [...html.matchAll(/<button\b[^>]*role="menuitem"[^>]*>/g)].map(([tag]) => tag);
    assert.ok(items.length > 0 && items.every((tag) => /disabled=""/.test(tag)));
  });
});
