import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_KIND } from '../domain/room-ownership.js';
import { canonicalDocName } from './relay-room-registry.js';
import { roomCodeOf, roomLink } from './room-links.js';

const CODE = 'Board123';
const TOKEN = 'secret-token_with-dashes';
const DOC_NAME = canonicalDocName(CODE, TOKEN);

test('a board links under /b/ and a Poker room under /p/, the capability token in the fragment', () => {
  assert.equal(roomLink(DOC_NAME, ROOM_KIND.BOARD), `/b/${CODE}#${TOKEN}`);
  assert.equal(roomLink(DOC_NAME, ROOM_KIND.POKER), `/p/${CODE}#${TOKEN}`);
});

test('a docName that is not a tokenized room has no link and no code', () => {
  for (const docName of ['yjs/public-wall', 'board-Board123-secret-token', `x${DOC_NAME}`, 'yjs/board-ab-shorttoken']) {
    assert.equal(roomLink(docName, ROOM_KIND.BOARD), null, docName);
    assert.equal(roomCodeOf(docName), null, docName);
  }
});

test('roomCodeOf returns the code part of a tokenized docName', () => {
  assert.equal(roomCodeOf(DOC_NAME), CODE);
});
