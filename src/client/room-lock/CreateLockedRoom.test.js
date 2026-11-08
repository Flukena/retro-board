import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const noop = () => {};
const PASSWORD = 'correct horse battery staple';
const form = (overrides = {}) => ({ password: PASSWORD, confirmation: PASSWORD, acknowledged: true, ...overrides });
const render = (CreateLockedRoomForm, props) => renderToStaticMarkup(React.createElement(CreateLockedRoomForm, {
  form: form(), onChange: noop, onSubmit: noop, busy: false, disabled: false, ...props,
}));

test('the form shows password fields, the notice list and the exact acknowledgement in both languages', async () => {
  await withChromeModule('/src/client/room-lock/CreateLockedRoom.jsx', ({ CreateLockedRoomForm }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      const html = render(CreateLockedRoomForm, {});
      assert.equal((html.match(/type="password"/g) || []).length, 2);
      assert.equal((html.match(/autoComplete="new-password"|autocomplete="new-password"/gi) || []).length, 2);
      assert.match(html, /type="checkbox"/);
      assert.equal((html.match(/<li>/g) || []).length, 3);
      assert.ok(html.includes(t('roomLock.create.ack')));
      assert.doesNotMatch(html, /roomLock\.create/);
    }
    setLang('en');
    assert.equal(t('roomLock.create.ack'), 'If you forget the password nobody can recover the data, including the server owner');
  });
});

test('submit is disabled until the form is valid, and while busy', async () => {
  await withChromeModule('/src/client/room-lock/CreateLockedRoom.jsx', ({ CreateLockedRoomForm }, { setLang }) => {
    setLang('en');
    assert.doesNotMatch(render(CreateLockedRoomForm, {}), /<button[^>]*disabled/);
    for (const bad of [{ acknowledged: false }, { password: 'short', confirmation: 'short' }, { confirmation: `${PASSWORD}x` }]) {
      assert.match(render(CreateLockedRoomForm, { form: form(bad) }), /<button[^>]*disabled/);
    }
    const busy = render(CreateLockedRoomForm, { busy: true });
    assert.match(busy, /<button[^>]*disabled/);
    assert.match(busy, /aria-busy="true"/);
  });
});

test('a mismatched confirmation is reported, an empty one is not', async () => {
  await withChromeModule('/src/client/room-lock/CreateLockedRoom.jsx', ({ CreateLockedRoomForm }, { setLang, t }) => {
    setLang('en');
    assert.ok(render(CreateLockedRoomForm, { form: form({ confirmation: 'nope' }) }).includes(t('roomLock.create.mismatch')));
    assert.equal(render(CreateLockedRoomForm, { form: form({ confirmation: '' }) }).includes(t('roomLock.create.mismatch')), false);
  });
});

test('guests and the loading state see nothing new on the landing page', async () => {
  await withChromeModule('/src/client/room-lock/CreateLockedRoom.jsx', ({ default: CreateLockedRoom }, { setLang, t }) => {
    setLang('en');
    const html = renderToStaticMarkup(React.createElement(CreateLockedRoom, { boardName: '', createBoard: noop, creating: false }));
    assert.equal(html, '');
    assert.equal(html.includes(t('roomLock.create.toggle')), false);
  });
});

test('an entitled user sees the toggle, and opening it reveals the form wired by id', async () => {
  await withChromeModule('/src/client/room-lock/CreateLockedRoom.jsx', ({ CreateLockedRoomOption }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      const props = { formId: 'lock-form', form: form(), onChange: noop, onSubmit: noop, onToggle: noop, busy: false, disabled: false };
      const closed = renderToStaticMarkup(React.createElement(CreateLockedRoomOption, { ...props, open: false }));
      assert.ok(closed.includes(t('roomLock.create.toggle')));
      assert.match(closed, /type="button"/);
      assert.match(closed, /aria-expanded="false"/);
      assert.doesNotMatch(closed, /<form/);
      const open = renderToStaticMarkup(React.createElement(CreateLockedRoomOption, { ...props, open: true }));
      assert.match(open, /aria-expanded="true"/);
      assert.match(open, /aria-controls="lock-form"/);
      assert.match(open, /<form id="lock-form"/);
    }
  });
});

test('a derivation failure is announced with the existing create-failure message', async () => {
  await withChromeModule('/src/client/room-lock/CreateLockedRoom.jsx', ({ CreateLockedRoomForm }, { setLang, t }) => {
    setLang('en');
    assert.ok(render(CreateLockedRoomForm, { failed: true }).includes(t('landing.create.error.unavailable')));
    assert.equal(render(CreateLockedRoomForm, { failed: false }).includes(t('landing.create.error.unavailable')), false);
  });
});
