import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { classGroups, targetsClass } from './scoped-class-test-helper.js';

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

const COMPONENT_CLASS_PATTERN = /^(?:rb-(?:dialog|help|timer-setup|selection-toolbar|landing|minimap)__|rb-(?:tool-dock|dock-tile|template|zone)(?:$|[-_]))/;
test('selector contract distinguishes target compounds from ancestors and incompatible classes', () => {
  const heading = new Set(['rb-dialog__heading']);
  assert.equal(targetsClass('.rb-input.rb-dialog__heading', 'rb-dialog__heading', heading), false);
  assert.equal(targetsClass('.rb-dialog__header.rb-dialog__heading', 'rb-dialog__heading', heading), false);
  assert.equal(targetsClass('.rb-dialog__header .rb-dialog__heading', 'rb-dialog__heading', heading), true);
  assert.equal(targetsClass('.rb-dialog__heading span', 'rb-dialog__heading', heading), false);
  const input = new Set(['rb-input', 'rb-dialog__pin-input']);
  assert.equal(targetsClass('.rb-input.rb-dialog__pin-input', 'rb-dialog__pin-input', input), true);
});

test('every scoped component class has a compatible stylesheet selector targeting its last compound', () => {
  for (const [component, stylesheet] of [
    ['Modals.jsx', 'modals.css'], ['TimerSetup.jsx', 'timer-setup.css'],
    ['SelectionToolbar.jsx', 'selection-toolbar.css'], ['Landing.jsx', 'landing.css'],
    ['MinimapPanel.jsx', 'minimap.css'], ['ToolDock.jsx', 'tool-dock.css'],
    ['ZoneCard.jsx', 'board-cards.css'],
  ]) {
    const source = readFileSync(new URL(component, import.meta.url), 'utf8');
    const css = readFileSync(new URL(stylesheet, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((rule) => rule[1].split(','));
    for (const elementClasses of classGroups(source)) {
      for (const className of [...elementClasses].filter((name) => COMPONENT_CLASS_PATTERN.test(name))) {
        assert.ok(selectors.some((selector) => targetsClass(selector, className, elementClasses)),
          component + ': no compatible last-compound selector for .' + className);
      }
    }
  }
});

test('save dialog describes its draft count; blank Save is disabled and Enter does nothing', async () => {
  await withChromeModule('/src/Modals.jsx', ({ SaveTemplateDialog }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      let tree;
      let saves = 0;
      let closes = 0;
      function InspectDialog() {
        tree = SaveTemplateDialog({ zoneCount: 3, onSave: () => { saves += 1; }, onClose: () => { closes += 1; } });
        return tree;
      }
      const markup = renderToStaticMarkup(React.createElement(InspectDialog));
      assert.ok(markup.includes(t('tmpl.saveDialog.count', { n: 3 })));
      assert.notEqual(t('tmpl.saveDialog.count', { n: 3 }), 'tmpl.saveDialog.count');
      const input = tree.props.children.find((child) => child?.type === 'input');
      input.props.onKeyDown({ key: 'Enter' });
      assert.equal(saves, 0);
      const save = tree.props.children.at(-1).props.children.at(-1);
      assert.equal(save.props.disabled, true);
      input.props.onKeyDown({ key: 'Escape' });
      assert.equal(closes, 1);
    }
  });
});
