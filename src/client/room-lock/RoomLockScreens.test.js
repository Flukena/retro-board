import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const noop = () => {};
const LOCKOUT_SECONDS = 17;
const SECRET = 'hunter2-hunter2';

const prompt = (PasswordPromptView, props) => renderToStaticMarkup(React.createElement(PasswordPromptView, {
  password: '', onPasswordChange: noop, onRememberChange: noop, onSubmit: noop,
  busy: false, error: null, lockedOutSeconds: 0, submitLabel: 'Go', ...props,
}));

test('the password screen explains the protection in both languages with no raw keys', async () => {
  await withChromeModule('/src/client/room-lock/RoomPasswordScreen.jsx', ({ default: RoomPasswordScreen }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      const html = renderToStaticMarkup(React.createElement(RoomPasswordScreen, { onUnlock: noop }));
      assert.ok(html.includes(t('roomLock.prompt.title')));
      assert.ok(html.includes(t('roomLock.prompt.body')));
      assert.ok(html.includes(t('roomLock.prompt.submit')));
      assert.ok(html.includes('type="password"'));
      assert.match(html, /<label[^>]*><input[^>]*type="checkbox"[^>]*>/);
      assert.doesNotMatch(html, /<input[^>]*type="checkbox"[^>]*checked/);
      assert.ok(html.includes(t('roomLock.prompt.remember')));
      assert.doesNotMatch(html, /roomLock\./);
    }
    setLang('en');
    assert.match(t('roomLock.prompt.body'), /cannot be recovered/);
  });
});

test('the prompt shows busy, wrong-password and lock-out states, and blocks submit while busy or limited', async () => {
  await withChromeModule('/src/client/room-lock/PasswordPrompt.jsx', ({ PasswordPromptView }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      const idle = prompt(PasswordPromptView, { password: SECRET });
      assert.doesNotMatch(idle, /disabled/);
      assert.doesNotMatch(idle, /role="alert"/);

      const busy = prompt(PasswordPromptView, { password: SECRET, busy: true });
      assert.ok(busy.includes(t('roomLock.prompt.busy')));
      assert.match(busy, /aria-busy="true"/);
      assert.match(busy, /<button[^>]*disabled/);
      assert.match(busy, /<input[^>]*type="checkbox"[^>]*disabled/);

      const wrong = prompt(PasswordPromptView, { password: SECRET, error: { kind: 'wrong', seconds: 0 } });
      assert.match(wrong, /role="alert"[^>]*>[^<]*</);
      assert.ok(wrong.includes(t('roomLock.prompt.wrong')));
      assert.doesNotMatch(wrong, /<button[^>]*disabled/);

      const limited = prompt(PasswordPromptView, {
        password: SECRET, lockedOutSeconds: LOCKOUT_SECONDS, error: { kind: 'locked-out', seconds: LOCKOUT_SECONDS },
      });
      assert.ok(limited.includes(t('roomLock.prompt.lockedOut', { seconds: LOCKOUT_SECONDS })));
      assert.match(limited, /<button[^>]*disabled/);
    }
  });
});

test('an empty password cannot be submitted', async () => {
  await withChromeModule('/src/client/room-lock/PasswordPrompt.jsx', ({ PasswordPromptView }) => {
    assert.match(prompt(PasswordPromptView, { password: '' }), /<button[^>]*disabled/);
  });
});

test('the re-unlock dialog requires a fresh choice in both languages and cannot be dismissed', async () => {
  await withChromeModule('/src/client/room-lock/ReunlockDialog.jsx', ({ ReunlockDialogView }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      const html = renderToStaticMarkup(React.createElement(ReunlockDialogView, { onUnlock: noop, remembered: true }));
      assert.match(html, /role="dialog"/);
      assert.match(html, /aria-modal="true"/);
      assert.ok(html.includes(t('roomLock.reunlock.title')));
      assert.ok(html.includes(t('roomLock.reunlock.body')));
      assert.ok(html.includes(t('roomLock.reunlock.submit')));
      assert.ok(html.includes(t('roomLock.prompt.remember')));
      assert.match(html, /<input[^>]*type="checkbox"/);
      assert.doesNotMatch(html, /<input[^>]*type="checkbox"[^>]*checked/);
      assert.doesNotMatch(html, /roomLock\./);
      assert.doesNotMatch(html, /rb-modal__close/);
    }
  });
});
