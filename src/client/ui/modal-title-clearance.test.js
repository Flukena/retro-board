import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

// ui.css keeps a dialog title clear of the close button only when the title's id ends with this suffix.
const UI_CSS = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const CLEARANCE_RULE = /\.rb-modal__panel:has\(\.rb-modal__close\) \[id\$="([^"]+)"\]\s*\{[^}]*padding-right/;
const CLEARANCE_SUFFIX = CLEARANCE_RULE.exec(UI_CSS)?.[1];
const TITLE_ID = /<[^>]*\bid="([^"]+)"[^>]*class="rb-dialog__title[^"]*"/;
const noop = () => {};

function assertTitleClearsClose(html, name) {
  const id = TITLE_ID.exec(html)?.[1];
  assert.ok(id, `${name}: renders a dialog title with an id`);
  assert.ok(id.endsWith(CLEARANCE_SUFFIX), `${name}: title id "${id}" opts into the close-button clearance`);
  assert.ok(html.includes(`aria-labelledby="${id}"`), `${name}: the dialog is labelled by its title`);
}

test('ui.css still reserves close-button room for dialog titles', () => {
  assert.ok(CLEARANCE_SUFFIX, 'the clearance rule exists');
});

// A long title (the Thai Planning Poker delete title) ran under the close button in the live check.
test('room management dialogs keep their titles clear of the close button', async () => {
  await withChromeModule('/src/client/ui/TypeToConfirmDialog.jsx', ({ TypeToConfirmView }) => {
    assertTitleClearsClose(renderToStaticMarkup(React.createElement(TypeToConfirmView, {
      title: 'Delete', body: 'Body', prompt: 'Type it', expected: 'code', typed: '', onTypedChange: noop,
      cancelLabel: 'Cancel', confirmLabel: 'Delete', onCancel: noop, onConfirm: noop,
    })), 'TypeToConfirm');
  });
  await withChromeModule('/src/client/ui/BoardTitleDialog.jsx', ({ BoardTitleDialog }) => {
    assertTitleClearsClose(renderToStaticMarkup(React.createElement(BoardTitleDialog, {
      initialTitle: 'Sprint', onCancel: noop, onSave: noop,
    })), 'BoardTitleDialog');
  });
});
