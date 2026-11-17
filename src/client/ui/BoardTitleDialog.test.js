import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { BOARD_TITLE_MAX_LENGTH } from '../../domain/security-boundaries.js';

const MODULE = '/src/client/ui/BoardTitleDialog.jsx';
const noop = () => {};
const saveButton = (html) => html.match(/<button[^>]*>[^<]*<\/button>/g).at(-1);

test('the rename dialog bounds the title and enables Save only for a title within bounds', async () => {
  await withChromeModule(MODULE, ({ BoardTitleDialog }, { t, setLang }) => {
    const html = (initialTitle) => renderToStaticMarkup(React.createElement(BoardTitleDialog, { initialTitle, onCancel: noop, onSave: noop }));
    for (const language of ['th', 'en']) {
      setLang(language);
      assert.ok(html('Sprint 12').includes(t('myBoards.renameTitle')));
    }
    assert.match(html('Sprint 12'), new RegExp(`maxLength="${BOARD_TITLE_MAX_LENGTH}"`));
    assert.match(html('Sprint 12'), /value="Sprint 12"/);
    assert.doesNotMatch(saveButton(html('Sprint 12')), /disabled/);
    for (const outOfBounds of [null, '   ', 'x'.repeat(BOARD_TITLE_MAX_LENGTH + 1)]) {
      assert.match(saveButton(html(outOfBounds)), /disabled=""/, JSON.stringify(outOfBounds));
    }
  });
});
