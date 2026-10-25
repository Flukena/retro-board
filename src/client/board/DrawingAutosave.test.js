import test from 'node:test';
import assert from 'node:assert/strict';
import { DrawingAutosave, DRAWING_AUTOSAVE_MIN_INTERVAL_MS } from './DrawingAutosave.js';
function clock() {
  let now = 0, callback = null, delay;
  return { Date: { now: () => now }, setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimeout() { callback = null; },
    tick() { now += delay; const run = callback; callback = null; run?.(); }, delay: () => delay };
}
test('autosaves without Done and serializes edits made while the previous upload is pending', async () => {
  const time = clock(), resolvers = []; let calls = 0;
  const autosave = new DrawingAutosave({ save: () => { calls++; return new Promise(resolve => resolvers.push(resolve)); } }, time);
  autosave.changed(); time.tick(); assert.equal(calls, 1);
  autosave.changed(); const flush = autosave.flush(); assert.equal(calls, 1);
  resolvers.shift()(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  resolvers.shift()(true); assert.equal(await flush, true); assert.equal(autosave.pending, false); autosave.dispose();
});
test('background uploads obey the interval; a failed upload stays dirty and can retry; disposal cancels scheduled writes', async () => {
  const time = clock(); let succeeds = true, calls = 0;
  const autosave = new DrawingAutosave({ save: async () => { calls++; return succeeds; } }, time);
  autosave.changed(); await autosave.flush(); autosave.changed(); assert.equal(time.delay(), DRAWING_AUTOSAVE_MIN_INTERVAL_MS);
  succeeds = false; assert.equal(await autosave.flush(), false); assert.equal(autosave.pending, true);
  succeeds = true; assert.equal(await autosave.flush(), true); assert.equal(calls, 3);
  autosave.changed(); autosave.dispose(); time.tick(); assert.equal(calls, 3);
});
