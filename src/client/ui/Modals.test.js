import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { COMMENT_CAROUSEL_STYLE } from '../board/card-look.js';
import { classGroups, targetsClass } from '../../test-support/scoped-class-test-helper.js';

test('confirmation contract keeps cancel focus, busy buttons, danger and warning semantics', async () => {
  await withChromeModule('/src/client/ui/Modals.jsx', ({ ConfirmDialog }) => {
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
  await withChromeModule('/src/client/ui/Modals.jsx', (modals, { setLang, getLang, t }) => {
    const originalLang = getLang();
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        const cases = [
          [modals.NameDialog, { draft: '' }, true, 'name-dialog-title'],
          [modals.HelpDialog, { sections: [] }, true, 'help-dialog-title'],
          [modals.CommentsDialog, { item: {}, comments: [], editingAllowed: true }, true, 'comments-dialog-title'],
          [modals.AdminPinDialog, { isSetting: true }, true, 'pin-dialog-title'],
          [modals.TemplateNameDialog, { mode: modals.TEMPLATE_NAME_MODE.SAVE, zoneCount: 1 }, true, 'template-dialog-title'],
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
          item: {}, comments: [{ id: 'one', text: 'hello', createdAt: Date.now() }], editingAllowed: false, onClose: () => {},
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
        const saving = renderToStaticMarkup(React.createElement(modals.TemplateNameDialog, { mode: modals.TEMPLATE_NAME_MODE.SAVE, zoneCount: 1 }));
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

test('confirmation and name cancel through the shared shell without submitting', async () => {
  await withChromeModule('/src/client/ui/Modals.jsx', ({ ConfirmDialog, NameDialog }) => {
    const events = [];
    const confirm = ConfirmDialog({
      onCancel: () => events.push('cancel'), onConfirm: () => events.push('confirm'),
    });
    confirm.props.onDismiss();
    assert.equal(confirm.props.dismissDisabled, undefined);
    const actions = confirm.props.children.at(-1).props.children;
    actions[0].props.onClick();
    actions[1].props.onClick();
    const name = NameDialog({
      draft: '', onDraftChange: (value) => events.push(value), onSave: () => events.push('save'), onClose: () => events.push('close'),
    });
    const input = name.props.children[1];
    input.props.onChange({ target: { value: 'Ada' } });
    input.props.onKeyDown({ key: 'Escape' });
    input.props.onKeyDown({ key: 'Enter' });
    name.props.onDismiss();
    assert.deepEqual(events, ['cancel', 'cancel', 'confirm', 'Ada', 'save', 'close']);
    assert.equal(name.props.labelledBy, 'name-dialog-title');
  });
});

const COMPONENT_CLASS_PATTERN = /^(?:rb-(?:dialog|help|timer-setup|selection-toolbar|landing|minimap)__|rb-(?:tool-dock|dock-tile|template|zone|sticky|card-overview|winner-medal)(?:$|[-_]))/;
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
    ['./Modals.jsx', './modals.css'], ['../voting/TimerSetup.jsx', '../voting/timer-setup.css'],
    ['../board/SelectionToolbar.jsx', '../board/selection-toolbar.css'], ['../app/Landing.jsx', '../app/landing.css'],
    ['../board/MinimapPanel.jsx', '../../domain/minimap.css'], ['../chrome/ToolDock.jsx', '../chrome/tool-dock.css'],
    ['../board/ZoneCard.jsx', '../board/board-cards.css'], ['../board/ZoneToolStrip.jsx', '../board/board-cards.css'], ['../board/StickyCard.jsx', '../board/board-cards.css'], ['../templates/TemplateThumbnail.jsx', '../templates/template-thumbnail.css'],
  ]) {
    const source = readFileSync(new URL(component, import.meta.url), 'utf8');
    const css = readFileSync(new URL(stylesheet, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // StickyCard's carousel selector still lives in the board's inline stylesheet.
    const inlineCss = component === '../board/StickyCard.jsx'
      ? COMMENT_CAROUSEL_STYLE
      : '';
    const selectors = [...(css + inlineCss).matchAll(/([^{}]+)\{/g)].flatMap((rule) => rule[1].split(','));
    for (const elementClasses of classGroups(source)) {
      for (const className of [...elementClasses].filter((name) => COMPONENT_CLASS_PATTERN.test(name))) {
        assert.ok(selectors.some((selector) => targetsClass(selector, className, elementClasses)),
          component + ': no compatible last-compound selector for .' + className);
      }
    }
  }
});

const checkTemplateNameState = ({ TemplateNameDialog, TEMPLATE_NAME_MODE, templateNameKeys, t, mode, initialName }) => {
  let tree;
  const submitted = [];
  let closes = 0;
  function InspectDialog() {
    tree = TemplateNameDialog({ mode, initialName, zoneCount: 3,
      onSubmit: (name) => submitted.push(name), onClose: () => { closes += 1; } });
    return tree;
  }
  const html = renderToStaticMarkup(React.createElement(InspectDialog));
  const input = tree.props.children.find((child) => child?.type === 'input');
  assert.equal(input.props.value, initialName);
  const enabled = mode === TEMPLATE_NAME_MODE.SAVE && initialName === 'Original';
  const save = tree.props.children.at(-1).props.children.at(-1);
  assert.equal(save.props.disabled, !enabled);
  input.props.onKeyDown({ key: 'Enter' });
  save.props.onClick();
  assert.equal(submitted.length, enabled ? 2 : 0);
  tree.props.onDismiss();
  assert.equal(closes, 1);
  assert.equal(html.includes(t('tmpl.saveDialog.count', { n: 3 })), mode === TEMPLATE_NAME_MODE.SAVE);
  assert.ok(html.includes(t(templateNameKeys(mode).heading)));
  assert.notEqual(t(templateNameKeys(mode).heading), templateNameKeys(mode).heading);
};

test('template name dialog modes validate names, count, keyboard and initial value in th/en', async () => {
  await withChromeModule('/src/client/ui/Modals.jsx', ({ TemplateNameDialog, TEMPLATE_NAME_MODE, templateNameKeys, templateNameCanSubmit }, { t, setLang }) => {
    assert.ok(Object.isFrozen(TEMPLATE_NAME_MODE));
    assert.throws(() => templateNameKeys('unknown'));
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const mode of Object.values(TEMPLATE_NAME_MODE)) {
        assert.equal(templateNameKeys(mode).button, 'common.save');
        for (const initialName of ['', '   ', 'Original']) {
          checkTemplateNameState({ TemplateNameDialog, TEMPLATE_NAME_MODE, templateNameKeys, t, mode, initialName });
        }
        for (const name of ['', '   ']) assert.equal(templateNameCanSubmit(mode, name, 'Original', 3), false);
      }
      assert.equal(templateNameCanSubmit(TEMPLATE_NAME_MODE.RENAME, ' Original ', 'Original', 3), false);
      assert.equal(templateNameCanSubmit(TEMPLATE_NAME_MODE.RENAME, 'Changed', 'Original', 0), true);
      assert.equal(templateNameCanSubmit(TEMPLATE_NAME_MODE.SAVE, 'New', '', 0), false);
    }
  });
});

test('confirmation and PIN expose consistent labelled dismissal and retain input autofocus', async () => {
  await withChromeModule('/src/client/ui/Modals.jsx', ({ ConfirmDialog, AdminPinDialog }) => {
    let cancels = 0;
    const onCancel = () => { cancels += 1; };
    const confirm = ConfirmDialog({ title: 'Confirm', onCancel });
    assert.equal(confirm.props.labelledBy, 'confirm-dialog-title');
    confirm.props.onDismiss();
    assert.equal(cancels, 1);
    let pin;
    function InspectPin() { pin = AdminPinDialog({ isSetting: false, onCancel }); return pin; }
    renderToStaticMarkup(React.createElement(InspectPin));
    const input = pin.props.children.find((child) => child?.type === 'input');
    assert.equal(input.props.autoFocus, true);
    pin.props.onDismiss();
    assert.equal(cancels, 2);
  });
});
