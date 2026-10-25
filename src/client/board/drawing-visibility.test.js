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
