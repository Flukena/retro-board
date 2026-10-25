import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleSettledViewport } from './use-settled-viewport.js';

function clock() {
  const pending = new Map(); let nextId = 0;
  return { pending, setTimeout: (callback, delay) => { assert.ok(delay > 0); pending.set(++nextId, callback); return nextId; },
    clearTimeout: id => pending.delete(id), tick: () => {
      const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback();
    } };
}
test('card detail coverage stays stable during input and commits the latest live viewport after release', () => {
  const scheduler = clock(), busy = { current: 'zoom' }, live = { current: { x: 0, y: 0, zoom: 1 } }, commits = [];
  const dispose = scheduleSettledViewport(live, [busy], value => commits.push(value), scheduler);
  live.current = { x: 40, y: -60, zoom: 0.5 }; scheduler.tick(); assert.deepEqual(commits, []);
  live.current = { x: 80, y: -120, zoom: 0.12 }; busy.current = null; scheduler.tick();
  assert.deepEqual(commits, [live.current]); assert.equal(commits[0], live.current);
  assert.equal(scheduler.pending.size, 0); dispose();
});
test('all interaction owners must finish, and cleanup prevents a deferred commit after unmount', () => {
  const scheduler = clock(), wheelFrame = { current: 0 }, trailingCommit = { current: 1 }, live = { current: {} }, commits = [];
  const dispose = scheduleSettledViewport(live, [wheelFrame, trailingCommit], value => commits.push(value), scheduler);
  wheelFrame.current = null; scheduler.tick(); assert.equal(commits.length, 0);
  dispose(); scheduler.tick(); assert.equal(commits.length, 0); assert.equal(scheduler.pending.size, 0);
});
test('an already settled viewport commits without scheduling another frame or timer', () => {
  const scheduler = clock(), live = { current: { x: 12, y: 24, zoom: 1 } }, commits = [];
  const dispose = scheduleSettledViewport(live, [{ current: null }], value => commits.push(value), scheduler);
  assert.deepEqual(commits, [live.current]); assert.equal(scheduler.pending.size, 0); dispose();
});
