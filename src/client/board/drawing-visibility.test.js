import test from 'node:test';
import assert from 'node:assert/strict';
import { hideDrawingImage } from './drawing-visibility.js';
test('overlapping local and remote eraser previews reveal their original only after both release', () => {
  const before = globalThis.CSS; globalThis.CSS = { escape: value => value };
  try {
    const element = { style: { visibility: 'visible' } }, document = { querySelector: () => element };
    const local = hideDrawingImage(document, 'drawing'), remote = hideDrawingImage(document, 'drawing');
    assert.equal(element.style.visibility, 'hidden'); local(); assert.equal(element.style.visibility, 'hidden');
    remote(); assert.equal(element.style.visibility, 'visible');
    assert.doesNotThrow(hideDrawingImage({ querySelector: () => null }, 'drawing'));
  } finally { if (before) globalThis.CSS = before; else delete globalThis.CSS; }
});
test('a drawing created after the hide request stays hidden until the lease ends', () => {
  const before = globalThis.CSS; globalThis.CSS = { escape: value => value };
  let current = null, callback, disconnected = false;
  const document = {
    documentElement: {}, querySelector: () => current,
    defaultView: { MutationObserver: class { constructor(onChange) { callback = onChange; } observe() {} disconnect() { disconnected = true; } } },
  };
  try {
    const release = hideDrawingImage(document, 'drawing');
    current = { style: { visibility: '' } }; callback();
    assert.equal(current.style.visibility, 'hidden'); assert.equal(disconnected, true);
    release(); assert.equal(current.style.visibility, '');
  } finally { if (before) globalThis.CSS = before; else delete globalThis.CSS; }
});
test('releasing a pending hide disconnects its observer before an image appears', () => {
  const before = globalThis.CSS; globalThis.CSS = { escape: value => value };
  let disconnected = false;
  const document = {
    documentElement: {}, querySelector: () => null,
    defaultView: { MutationObserver: class { observe() {} disconnect() { disconnected = true; } } },
  };
  try {
    const release = hideDrawingImage(document, 'drawing'); release();
    assert.equal(disconnected, true);
  } finally { if (before) globalThis.CSS = before; else delete globalThis.CSS; }
});
