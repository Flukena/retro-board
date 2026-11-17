import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const LANGUAGES = ['th', 'en'];
const LOCKOUT_SECONDS = 17;
const noop = () => {};
const filled = { current: 'current password', password: 'new password 1', confirmation: 'new password 1', acknowledged: true };

async function withModules(check) {
  const server = await createServer({
    configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  try {
    const load = (path) => server.ssrLoadModule(path);
    await check({
      menu: await load('/src/client/room-lock/RoomLockMenu.jsx'),
      dialogs: await load('/src/client/room-lock/RoomLockDialogs.jsx'),
      popovers: await load('/src/client/chrome/TopBarPopovers.jsx'),
      store: await load('/src/client/room-lock/room-lock-dialog-store.js'),
      i18n: await load('/src/client/ui/i18n.js'),
    });
  } finally {
    await server.close();
  }
}

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('the owner sees rename, change-password and remove-everyone in both languages; anyone else sees nothing', async () => {
  await withModules(async ({ menu, store, i18n: { setLang, t } }) => {
    assert.equal(render(menu.RoomLockMenuItems, { isOwner: false, onSelect: noop }), '');
    for (const language of LANGUAGES) {
      setLang(language);
      const html = render(menu.RoomLockMenuItems, { isOwner: true, onSelect: noop });
      assert.ok(html.includes(t('roomLock.menu.rename')));
      assert.ok(html.includes(t('roomLock.menu.changePassword')));
      assert.ok(html.includes(t('roomLock.menu.removeEveryone')));
      assert.doesNotMatch(html, /roomLock\./);
    }
    const chosen = [];
    const items = menu.RoomLockMenuItems({ isOwner: true, onSelect: (dialog) => chosen.push(dialog) }).props.children;
    items.filter((item) => item.props.onClick).forEach((item) => item.props.onClick());
    assert.deepEqual(chosen, [store.ROOM_LOCK_DIALOG.RENAME, store.ROOM_LOCK_DIALOG.PASSWORD, store.ROOM_LOCK_DIALOG.ROTATE]);
  });
});

test('the More menu hosts the lock menu, which renders nothing on a board without an owner key', async () => {
  await withModules(async ({ menu, popovers }) => {
    const close = () => {};
    const tree = popovers.MorePopover({ isAdmin: true, onClose: close });
    const hosted = tree.props.children.find((child) => child?.type === menu.default);
    assert.ok(hosted, 'MorePopover renders RoomLockMenu');
    assert.equal(hosted.props.onClose, close);
    assert.equal(render(menu.default, { onClose: close }), '', 'no unlocked owner key: no entries');
  });
});

test('the new-password form shows mismatch, same-password and every failure message, and blocks submit until valid', async () => {
  await withModules(async ({ dialogs: { NewPasswordForm }, i18n: { setLang, t } }) => {
    const form = (props) => render(NewPasswordForm, {
      form: filled, onChange: noop, onSubmit: noop, onCancel: noop, busy: false, error: null, submitLabel: 'Go', busyLabel: 'Working', ...props,
    });
    for (const language of LANGUAGES) {
      setLang(language);
      const ready = form({});
      assert.equal((ready.match(/type="password"/g) || []).length, 3, 'current, new and confirmation');
      assert.ok(ready.includes(t('roomLock.create.ack')), 'the no-recovery acknowledgement');
      assert.doesNotMatch(ready, /<button type="submit"[^>]*disabled/);
      assert.doesNotMatch(ready, /roomLock\./);
      assert.ok(form({ form: { ...filled, confirmation: 'other' } }).includes(t('roomLock.create.mismatch')));
      const same = form({ form: { ...filled, current: filled.password } });
      assert.ok(same.includes(t('roomLock.change.same')));
      assert.match(same, /<button type="submit"[^>]*disabled/);
      assert.match(form({ form: { ...filled, acknowledged: false } }), /<button type="submit"[^>]*disabled/);
      for (const [kind, key] of [['storage-full', 'roomLock.rotate.storageFull'], ['board-changed', 'roomLock.rotate.boardChanged'],
        ['lock-changed', 'roomLock.manage.lockChanged'], ['wrong', 'roomLock.prompt.wrong'], ['timeout', 'roomLock.rotate.timeout']]) {
        assert.ok(form({ error: { kind, seconds: 0 } }).includes(t(key)), kind);
      }
      const limited = form({ error: { kind: 'locked-out', seconds: LOCKOUT_SECONDS }, lockedOutSeconds: LOCKOUT_SECONDS });
      assert.ok(limited.includes(t('roomLock.prompt.lockedOut', { seconds: LOCKOUT_SECONDS })));
      assert.match(limited, /<button type="submit"[^>]*disabled/);
      const busy = form({ busy: true });
      assert.ok(busy.includes('Working'));
      assert.match(busy, /aria-busy="true"/);
    }
    setLang('en');
    assert.equal(t('roomLock.rotate.storageFull'), 'Not enough room storage to re-encrypt images');
  });
});

test('an owner dialog is modal and cannot be dismissed while its action runs; notices render as a status', async () => {
  await withModules(async ({ dialogs: { OwnerDialogView, RoomLockNoticeView }, i18n: { setLang, t } }) => {
    const dialog = (busy) => render(OwnerDialogView, { titleId: 'x', title: 'Title', paragraphs: ['Body'], onClose: noop, busy });
    assert.match(dialog(false), /aria-modal="true"/);
    assert.doesNotMatch(dialog(false), /rb-modal__close"[^>]*disabled/);
    assert.match(dialog(true), /<button[^>]*disabled[^>]*rb-modal__close|rb-modal__close[^>]*disabled/);
    for (const language of LANGUAGES) {
      setLang(language);
      for (const key of ['roomLock.notice.skipped', 'roomLock.notice.roomFull', 'roomLock.change.done']) {
        const html = render(RoomLockNoticeView, { messageKey: key });
        assert.match(html, /role="status"/);
        assert.ok(html.includes(t(key)));
      }
    }
  });
});

test('rename opens on the board title and closes only after the board accepted the new title', async () => {
  await withModules(async ({ dialogs: { RenameBoardDialog }, i18n: { setLang, t } }) => {
    const renamed = [];
    let closed = 0;
    const writer = { title: 'Sprint 12', rename: (raw) => { renamed.push(raw); return raw.trim() === 'Sprint 13'; } };
    const element = RenameBoardDialog({ writer, onClose: () => { closed += 1; } });
    for (const language of LANGUAGES) {
      setLang(language);
      const html = renderToStaticMarkup(element);
      assert.ok(html.includes(t('myBoards.renameTitle')));
      assert.match(html, /value="Sprint 12"/);
    }
    element.props.onSave('rejected');
    assert.equal(closed, 0, 'a refused rename keeps the dialog open');
    element.props.onSave(' Sprint 13 ');
    assert.deepEqual(renamed, ['rejected', ' Sprint 13 ']);
    assert.equal(closed, 1);
    assert.equal(RenameBoardDialog({ writer: null, onClose: noop }), null, 'no open board: nothing to rename');
  });
});
