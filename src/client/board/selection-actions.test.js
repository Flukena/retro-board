import test from 'node:test';
import assert from 'node:assert/strict';

import { unlockEntriesForSelection } from './selection-actions.js';

test('builds unlock patches only for locked objects covered by the marquee', () => {
  const items = [
    { id: 'locked-zone', type: 'zone', locked: true },
    { id: 'open-zone', type: 'zone', locked: false },
    { id: 'outside-zone', type: 'zone', locked: true },
    { id: 'sticky', type: 'sticky', private: true },
  ];

  assert.deepEqual(
    unlockEntriesForSelection(items, new Set(['locked-zone', 'open-zone', 'sticky'])),
    [{ id: 'locked-zone', patch: { locked: false } }],
  );
});
