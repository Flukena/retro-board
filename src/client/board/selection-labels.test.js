import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteSelectionLabels, selectionLabelMessage } from './selection-labels.js';

const ALICE = { userId: 'alice', name: 'Alice', extraCount: 0 };
const BOB = { userId: 'bob', name: 'Bob', extraCount: 0 };
const card = (id, x, y, type = 'sticky') => ({ id, type, x, y });

test('stacked cards selected by one person get a single label at the top-left of the group', () => {
  const items = [card('a', 300, 200), card('b', 340, 240), card('c', 380, 180), card('d', 900, 900)];
  const selectors = new Map([['a', ALICE], ['b', ALICE], ['c', ALICE]]);
  const labels = remoteSelectionLabels(items, selectors);
  assert.equal(labels.length, 1);
  assert.deepEqual({ x: labels[0].x, y: labels[0].y, count: labels[0].count }, { x: 300, y: 180, count: 3 });
  assert.equal(labels[0].selector.name, 'Alice');
});

test('each person who is selecting gets their own label', () => {
  const items = [card('a', 0, 0), card('b', 50, 50), card('c', 500, 500)];
  const selectors = new Map([['a', ALICE], ['b', BOB], ['c', BOB]]);
  const labels = remoteSelectionLabels(items, selectors);
  assert.deepEqual(labels.map(l => [l.selector.userId, l.count, l.x, l.y]), [['alice', 1, 0, 0], ['bob', 2, 50, 50]]);
  assert.notEqual(labels[0].key, labels[1].key);
});

test('zones and unselected cards never get a selection label', () => {
  const items = [card('z', 0, 0, 'zone'), card('a', 10, 10)];
  assert.deepEqual(remoteSelectionLabels(items, new Map([['z', ALICE]])), []);
  assert.deepEqual(remoteSelectionLabels(items, new Map()), []);
});

test('the label names the card count only when one person selects several cards', () => {
  assert.deepEqual(selectionLabelMessage({ selector: ALICE, count: 1 }), ['selection.by', { name: 'Alice' }]);
  assert.deepEqual(selectionLabelMessage({ selector: ALICE, count: 4 }), ['selection.byCount', { name: 'Alice', n: 4 }]);
  assert.deepEqual(selectionLabelMessage({ selector: { ...ALICE, extraCount: 2 }, count: 4 }),
    ['selection.byMany', { name: 'Alice', n: 2 }]);
});
