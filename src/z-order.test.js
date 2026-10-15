import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveZIndex, compareZOrder, swapZOrderEntries } from './z-order.js';

const applyEntries = (items, entries) => items.map((item) => ({
  ...item, ...entries.find((entry) => entry.id === item.id)?.patch,
})).sort(compareZOrder);
const ids = (items) => items.map((item) => item.id);

test('z order uses explicit zero, falls back to creation time and breaks ties by id', () => {
  assert.equal(effectiveZIndex({ zIndex: 0, createdAt: 20 }), 0);
  assert.equal(effectiveZIndex({ createdAt: 20 }), 20);
  assert.deepEqual(ids([{ id: 'z', createdAt: 1 }, { id: 'b', createdAt: 0 }, { id: 'a', createdAt: 1 }].sort(compareZOrder)), ['b', 'a', 'z']);
});

test('adjacent z swaps move exactly one step across untied and tied groups', () => {
  for (const values of [[1, 2, 3, 4], [1, 2, 2, 4], [2, 2, 2, 2], [1, 1, 2, 2]]) {
    const items = values.map((createdAt, index) => ({ id: String(index), createdAt }));
    for (const [from, to] of [[0, 1], [1, 2], [2, 1], [3, 2]]) {
      const expected = ids(items);
      [expected[from], expected[to]] = [expected[to], expected[from]];
      const entries = swapZOrderEntries(items, from, to);
      assert.deepEqual(ids(applyEntries(items, entries)), expected);
      assert.deepEqual(items.map((item) => item.createdAt), values);
    }
  }
});

test('unrepresentable floating point gaps reindex deterministically', () => {
  const items = [1, 1 + Number.EPSILON, 1 + Number.EPSILON, 1 + Number.EPSILON * 2]
    .map((zIndex, index) => ({ id: String(index), zIndex }));
  const entries = swapZOrderEntries(items, 1, 2);
  assert.deepEqual(ids(applyEntries(items, entries)), ['0', '2', '1', '3']);
  assert.equal(entries.length, items.length);
});
