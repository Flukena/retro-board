import test from 'node:test';
import assert from 'node:assert/strict';
import { focusIfInside } from './focus-return.js';

// A popup root holding `children`, in a document whose focused element is `activeElement`.
const rootHolding = (children, activeElement) => ({
  current: { ownerDocument: { activeElement }, contains: (node) => children.includes(node) },
});
const focusTarget = () => {
  const target = { focused: 0, focus() { target.focused += 1; } };
  return { current: target };
};

test('focus moves to the target only when the focused element is inside the root', () => {
  const item = {};
  const inside = focusTarget();
  focusIfInside(rootHolding([item], item), inside);
  assert.equal(inside.current.focused, 1);
  const outside = focusTarget();
  focusIfInside(rootHolding([item], {}), outside);
  assert.equal(outside.current.focused, 0, 'focus elsewhere on the page is left alone');
});

test('a missing root or target changes nothing', () => {
  const target = focusTarget();
  assert.doesNotThrow(() => focusIfInside({ current: null }, target));
  assert.equal(target.current.focused, 0);
  const item = {};
  assert.doesNotThrow(() => focusIfInside(rootHolding([item], item), { current: null }));
});
