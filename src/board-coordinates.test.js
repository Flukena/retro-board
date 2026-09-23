import test from 'node:test';
import assert from 'node:assert/strict';

import { clientPointToWorld } from './board-coordinates.js';

const renderedWorldStub = ({ left, top, width, height, offsetWidth = 100, offsetHeight = 100 }) => ({
  offsetWidth,
  offsetHeight,
  getBoundingClientRect: () => ({ left, top, width, height }),
});

test('maps an external file drop to the world point under the cursor', () => {
  // The measured element is exactly 100 world units wide/high. Its rendered
  // rect therefore contains both the world origin and rendered world scale.
  const renderedWorld = renderedWorldStub({ left: 160, top: -20, width: 50, height: 50 });

  assert.deepEqual(clientPointToWorld(310, 80, renderedWorld), {
    x: 300,
    y: 200,
  });
});

test('keeps the drop aligned when board and browser zoom are composed', () => {
  const renderedWorld = renderedWorldStub({ left: 64, top: 18, width: 40, height: 40 });

  // World point (300, 200) is visibly painted at client position (184, 98).
  assert.deepEqual(clientPointToWorld(184, 98, renderedWorld), {
    x: 300,
    y: 200,
  });
});
