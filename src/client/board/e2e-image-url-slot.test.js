import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageUrlSlot } from './e2e-image-url-slot.js';

function fakeResolver() {
  const leases = [];
  const resolve = (src) => {
    const lease = { src, released: false, settle: null, reject: null };
    lease.url = new Promise((ok, fail) => { lease.settle = ok; lease.reject = fail; });
    lease.release = () => { lease.released = true; };
    leases.push(lease);
    return lease;
  };
  return { resolve, leases };
}
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

test('A to B to A with B pending never shows a revoked URL', async () => {
  const { resolve, leases } = fakeResolver();
  const states = [];
  const slot = createImageUrlSlot({ resolve, onChange: (state) => states.push(state) });
  slot.setSrc('A');
  leases[0].settle('blob:a1');
  await flush();
  slot.setSrc('B');
  assert.equal(leases[0].released, true);
  slot.setSrc('A');
  assert.deepEqual(states.at(-1), { src: 'A', url: null }, 'the released lease URL is gone at once');
  leases[0].settle('blob:late-a1');
  leases[1].settle('blob:b');
  await flush();
  assert.deepEqual(states.at(-1), { src: 'A', url: null }, 'results of released leases are ignored');
  leases[2].settle('blob:a2');
  await flush();
  assert.deepEqual(states.at(-1), { src: 'A', url: 'blob:a2' });
});

test('a failed load shows no URL, and disposal clears it before releasing', async () => {
  const { resolve, leases } = fakeResolver();
  const states = [];
  const slot = createImageUrlSlot({ resolve, onChange: (state) => states.push(state) });
  slot.setSrc('A');
  leases[0].settle('blob:a');
  await flush();
  slot.setSrc('B');
  leases[1].reject(new Error('broken'));
  await flush();
  assert.deepEqual(states.at(-1), { src: 'B', url: null });
  slot.setSrc('A');
  leases[2].settle('blob:a');
  await flush();
  slot.dispose();
  assert.deepEqual(states.at(-1), { src: null, url: null });
  assert.equal(leases[2].released, true);
  leases[2].settle('blob:ignored');
  await flush();
  assert.deepEqual(states.at(-1), { src: null, url: null });
});
