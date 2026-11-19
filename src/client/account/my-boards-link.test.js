import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_STATUS } from './account-api.js';
import { myBoardsHrefFor } from './my-boards-link.js';

const OFF_HOME_PATHS = Object.freeze(['/agile-scrum', '/th/agile-scrum/', '/planning-poker', '/templates/mad-sad-glad', '/privacy']);
const HOME_PATHS = Object.freeze(['/', '/index.html', '/th', '/th/', '/ja/index.html']);

test('signed in, off the home page: My boards links home', () => {
  for (const pathname of OFF_HOME_PATHS) assert.equal(myBoardsHrefFor(ACCOUNT_STATUS.SIGNED_IN, pathname), '/', pathname);
});

test('signed in, on the home page: no My boards item, because the page already is My boards', () => {
  for (const pathname of HOME_PATHS) assert.equal(myBoardsHrefFor(ACCOUNT_STATUS.SIGNED_IN, pathname), null, pathname);
});

test('not signed in: no My boards item anywhere', () => {
  const statuses = [ACCOUNT_STATUS.SIGNED_OUT, ACCOUNT_STATUS.DISABLED, ACCOUNT_STATUS.UNAVAILABLE, null];
  for (const status of statuses) {
    for (const pathname of [...OFF_HOME_PATHS, ...HOME_PATHS]) {
      assert.equal(myBoardsHrefFor(status, pathname), null, `${status} ${pathname}`);
    }
  }
});
