import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { MAX_OWNED_ROOMS_PER_ACCOUNT } from '../../domain/room-ownership.js';
import { CREATE_ERROR } from './create-board-error.js';

const LANGUAGES = ['th', 'en'];

test('the owned-room limit shows its own translated message with the limit', async () => {
  await withChromeModule('/src/client/app/CreateBoardError.jsx', ({ default: CreateBoardError }, { setLang, t }) => {
    for (const language of LANGUAGES) {
      setLang(language);
      const markup = renderToStaticMarkup(React.createElement(CreateBoardError, { error: { code: CREATE_ERROR.OWNED_ROOM_LIMIT } }));
      const expected = t('landing.create.error.ownedRoomLimit', { max: MAX_OWNED_ROOMS_PER_ACCOUNT });
      assert.ok(markup.includes(expected), language);
      assert.ok(markup.includes(String(MAX_OWNED_ROOMS_PER_ACCOUNT)), `${language} names the limit`);
      assert.notEqual(expected, t('landing.create.error.unavailable'), `${language} is not the generic failure`);
    }
  });
});
