import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forgetRecent,
  isBoardCreatedByMe,
  loadRecents,
  markBoardCreated,
  rememberRecent,
} from './router.js';

const installStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
    },
  });
  return values;
};

test('malformed recent storage is normalized to an empty list', () => {
  installStorage({ rb_recents: '"not-an-array"' });
  assert.deepEqual(loadRecents(), []);

  installStorage({
    rb_recents: JSON.stringify([
      null,
      { code: '../bad', token: null },
      { code: 'Room1234', token: 'valid_token', name: 42, visitedAt: -1 },
    ]),
  });
  assert.deepEqual(loadRecents(), [{
    code: 'Room1234', token: 'valid_token', name: '', visitedAt: 0,
  }]);
});

test('refreshing a recent preserves its existing board name', () => {
  installStorage();
  rememberRecent('Room1234', '  Planning retro  ', 'valid_token');
  rememberRecent('Room1234', undefined, 'valid_token');
  assert.equal(loadRecents()[0].name, 'Planning retro');

  forgetRecent('Room1234', 'valid_token');
  assert.deepEqual(loadRecents(), []);
});

test('malformed creator storage is repaired by the next create marker', () => {
  installStorage({ rb_created_boards: '{}' });
  markBoardCreated('Room1234', 'valid_token');
  assert.equal(isBoardCreatedByMe('Room1234', 'valid_token'), true);
});
