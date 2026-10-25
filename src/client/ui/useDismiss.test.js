import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeDismiss } from './useDismiss.js';

test('dismiss listens for Escape and outside pointerdown, ignores inside and cleans up on close', () => {
  const target = new EventTarget();
  const inside = {};
  const ref = { current: { contains: (node) => node === inside } };
  let dismissals = 0;
  const close = subscribeDismiss(ref, () => { dismissals += 1; }, target);
  const key = (value) => { const event = new Event('keydown'); event.key = value; target.dispatchEvent(event); };
  const pointer = (node) => {
    const event = new Event('pointerdown');
    Object.defineProperty(event, 'target', { value: node });
    target.dispatchEvent(event);
  };
  key('Enter'); pointer(inside);
  assert.equal(dismissals, 0);
  key('Escape'); pointer({});
  assert.equal(dismissals, 2);
  close(); key('Escape'); pointer({});
  assert.equal(dismissals, 2);
});

test('a portalled menu is inside the dismissal boundary as well as its trigger', () => {
  const target = new EventTarget();
  const portalNode = {};
  const ref = { current: { contains: () => false } };
  const popup = { current: { contains: node => node === portalNode } };
  let closes = 0;
  const cleanup = subscribeDismiss(ref, () => { closes++; }, target, popup);
  const event = new Event('pointerdown');
  Object.defineProperty(event, 'target', { value: portalNode });
  target.dispatchEvent(event);
  assert.equal(closes, 0, 'Clicking a popup action must not remove the popup before click dispatch');
  cleanup();
});
