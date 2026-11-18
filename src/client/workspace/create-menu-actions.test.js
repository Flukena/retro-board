import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuActions } from './create-menu-actions.js';
import { ROOM_KIND } from '../app/router.js';

const recorder = () => {
  const requests = [];
  return { requests, createBoard: (request) => { requests.push(request); } };
};
const LOCK = Object.freeze({ salt: 'public-lock-record' });

test('blank sends only the name', () => {
  const { requests, createBoard } = recorder();
  createMenuActions(createBoard).blank('Sprint 12');
  assert.deepEqual(requests, [{ name: 'Sprint 12' }]);
});

test('template sends only the starter slug', () => {
  const { requests, createBoard } = recorder();
  createMenuActions(createBoard).template('start-stop-continue');
  assert.deepEqual(requests, [{ starter: 'start-stop-continue' }]);
});

test('poker sends the poker room kind', () => {
  const { requests, createBoard } = recorder();
  createMenuActions(createBoard).poker();
  assert.deepEqual(requests, [{ kind: ROOM_KIND.POKER }]);
});

test('locked sends the name and the public lock record, nothing else', () => {
  const { requests, createBoard } = recorder();
  createMenuActions(createBoard).locked({ name: 'Private', lock: LOCK, password: 'never-forwarded' });
  assert.deepEqual(requests, [{ name: 'Private', lock: LOCK }]);
});
