import test from 'node:test';
import assert from 'node:assert/strict';
import { roomLogId } from './relay-log-id.js';

const PRIVATE_ROOM = 'private-room-capability';

test('relay log identifiers are stable keyed hexadecimal pseudonyms', () => {
  const id = roomLogId(PRIVATE_ROOM);
  assert.match(id, /^[a-f0-9]{12}$/);
  assert.equal(roomLogId(PRIVATE_ROOM), id);
  assert.notEqual(roomLogId('another-private-room'), id);
  assert.equal(id.includes(PRIVATE_ROOM), false);
});
