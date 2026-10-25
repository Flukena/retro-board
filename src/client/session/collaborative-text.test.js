import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  createCollaborativeText,
  describeTextReplacement,
  mapSelectionIndexThroughReplacement,
  replaceCollaborativeText,
  setCollaborativeTextField,
} from './collaborative-text.js';

test('updates only the changed range of collaborative text', () => {
  const doc = new Y.Doc();
  const sharedText = createCollaborativeText('hello world');
  doc.getMap('item').set('text', sharedText);
  const deltas = [];
  sharedText.observe((event) => deltas.push(event.delta));

  replaceCollaborativeText(sharedText, 'hello brave world');

  assert.equal(sharedText.toString(), 'hello brave world');
  assert.deepEqual(deltas, [[{ retain: 6 }, { insert: 'brave ' }]]);
});

test('concurrent character edits merge and converge instead of overwriting', () => {
  const first = new Y.Doc();
  const firstItem = first.getMap('items');
  const firstText = createCollaborativeText('A');
  firstItem.set('text', firstText);

  const second = new Y.Doc();
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  const firstBaseline = Y.encodeStateVector(first);
  const secondBaseline = Y.encodeStateVector(second);
  const secondText = second.getMap('items').get('text');

  replaceCollaborativeText(firstText, 'AB');
  replaceCollaborativeText(secondText, 'AC');

  const firstUpdate = Y.encodeStateAsUpdate(first, secondBaseline);
  const secondUpdate = Y.encodeStateAsUpdate(second, firstBaseline);
  Y.applyUpdate(first, secondUpdate);
  Y.applyUpdate(second, firstUpdate);

  const firstResult = firstText.toString();
  const secondResult = secondText.toString();
  assert.equal(firstResult, secondResult);
  assert.equal(firstResult.length, 3);
  assert.match(firstResult, /A/);
  assert.match(firstResult, /B/);
  assert.match(firstResult, /C/);
});

test('seeds collaborative text without reading a detached item map', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const item = new Y.Map();
    assert.equal(setCollaborativeTextField(item, 'text', 'hello'), true);

    const doc = new Y.Doc();
    doc.getMap('items').set('item-1', item);
    const sharedText = item.get('text');
    assert.equal(sharedText.toString(), 'hello');

    assert.equal(setCollaborativeTextField(item, 'text', 'hello world'), true);
    assert.equal(item.get('text'), sharedText);
    assert.equal(sharedText.toString(), 'hello world');
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
});

test('maps an active caret through a remote insertion', () => {
  const change = describeTextReplacement('hello world', 'hello kind world');
  assert.equal(mapSelectionIndexThroughReplacement(11, change), 16);
  assert.equal(mapSelectionIndexThroughReplacement(3, change), 3);
});
