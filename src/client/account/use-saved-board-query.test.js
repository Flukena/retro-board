import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { startSavedBoardRead } from './use-saved-board-query.js';

test('a discarded mount spends no request and a late result cannot change another board', async () => {
  const events = [];
  const read = () => { events.push('request'); return true; };
  const accept = value => events.push(value);
  const fail = () => events.push('error');
  startSavedBoardRead(read, accept, fail)();
  const cancel = startSavedBoardRead(read, accept, fail);
  await Promise.resolve();
  cancel();
  await setImmediate();
  assert.deepEqual(events, ['request']);
  startSavedBoardRead(read, accept, fail);
  startSavedBoardRead(() => Promise.reject(new Error('offline')), accept, fail);
  await setImmediate();
  assert.deepEqual(events, ['request', 'request', true, 'error']);
});
