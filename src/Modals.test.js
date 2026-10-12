import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('confirmation contract keeps cancel focus, busy buttons, danger and warning semantics', async () => {
  await withChromeModule('/src/Modals.jsx', ({ ConfirmDialog }) => {
    const html = renderToStaticMarkup(ConfirmDialog({
      title: 'Clear', body: 'Body', cancelLabel: 'Cancel', confirmLabel: 'Clear',
      confirmVariant: 'danger', busy: true, notes: ['Warning one', 'Warning two'],
    }));
    assert.match(html, /rb-btn--danger/);
    assert.equal((html.match(/disabled=""/g) || []).length, 2);
    assert.match(html, /autofocus=""/);
    assert.equal((html.match(/role="note"/g) || []).length, 2);
    assert.match(html, /role="dialog" aria-modal="true"/);
  });
});

test('extracted dialogs preserve attributes, focus and disabled states in both languages', async () => {
  await withChromeModule('/src/Modals.jsx', (modals, { setLang, getLang, t }) => {
    const originalLang = getLang();
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        const cases = [
          [modals.NameDialog, { draft: '' }, false, undefined],
          [modals.HelpDialog, { sections: [] }, true, undefined],
          [modals.CommentsDialog, { item: {}, comments: [], editingAllowed: true }, true, 'comments-dialog-title'],
          [modals.AdminPinDialog, { isSetting: true }, true, undefined],
          [modals.SaveTemplateDialog, { zoneCount: 1 }, true, undefined],
        ];
        for (const [Component, props, dialog, label] of cases) {
          const html = renderToStaticMarkup(React.createElement(Component, props));
          assert.equal(html.includes('role="dialog"'), dialog);
          assert.equal(html.includes('aria-modal="true"'), dialog);
          assert.equal(html.includes('aria-labelledby='), label !== undefined);
          if (label) assert.match(html, new RegExp('aria-labelledby="' + label + '"'));
          assert.doesNotMatch(html, /data-board-shortcuts=/);
          if (Component !== modals.HelpDialog) assert.match(html, /autofocus=""/);
        }
        const comments = renderToStaticMarkup(React.createElement(modals.CommentsDialog, {
          item: {}, comments: [{ id: 'one', text: 'hello', createdAt: Date.now() }], editingAllowed: false,
        }));
        assert.match(comments, /<button[^>]*autofocus=""/);
        assert.match(comments, /<textarea[^>]*disabled=""/);
        assert.doesNotMatch(comments, /<textarea[^>]*autofocus=""/);
        assert.ok(comments.includes(t('comments.anonymous')));
        const setting = renderToStaticMarkup(React.createElement(modals.AdminPinDialog, { isSetting: true }));
        const verifying = renderToStaticMarkup(React.createElement(modals.AdminPinDialog, { isSetting: false }));
        assert.equal((setting.match(/type="password"/g) || []).length, 2);
        assert.equal((verifying.match(/type="password"/g) || []).length, 1);
        assert.match(setting, /<button[^>]*disabled=""/);
        const saving = renderToStaticMarkup(React.createElement(modals.SaveTemplateDialog, { zoneCount: 1 }));
        assert.match(saving, /<button[^>]*disabled=""/);
        for (const key of [
          'pin.setHead', 'pin.verifyHead', 'pin.setBody', 'pin.verifyBody', 'pin.confirm',
          'pin.wrong', 'pin.mismatch', 'pin.set', 'pin.unlock', 'pin.genericError', 'pin.placeholder',
          'comments.anonymous',
        ]) assert.notEqual(t(key), key);
      }
    } finally {
      setLang(originalLang);
    }
  });
});

test('confirmation and name report events without adding dismissal or keyboard behavior', async () => {
  await withChromeModule('/src/Modals.jsx', ({ ConfirmDialog, NameDialog }) => {
    const events = [];
    const confirm = ConfirmDialog({
      onCancel: () => events.push('cancel'), onConfirm: () => events.push('confirm'),
    });
    assert.equal(confirm.props.onDismiss, undefined);
    const actions = confirm.props.children.at(-1).props.children;
    actions[0].props.onClick();
    actions[1].props.onClick();
    const name = NameDialog({
      draft: '', onDraftChange: (value) => events.push(value), onSave: () => events.push('save'),
    });
    const input = name.props.children[1];
    input.props.onChange({ target: { value: 'Ada' } });
    input.props.onKeyDown({ key: 'Escape' });
    input.props.onKeyDown({ key: 'Enter' });
    assert.deepEqual(events, ['cancel', 'confirm', 'Ada', 'save']);
    assert.equal(name.props.role, undefined);
    assert.equal(name.props.onDismiss, undefined);
  });
});
