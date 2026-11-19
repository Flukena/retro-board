import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenToStillImage } from './image-canvas.js';
import { apngBlob } from '../../test-support/apng-fixture.js';

function installGlobals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
}

const decodedImage = (width, height, fail = false) => class {
  naturalWidth = width;
  naturalHeight = height;
  set src(value) { queueMicrotask(() => (fail ? this.onerror(new Event('error')) : this.onload())); }
};

const fakeCanvasEnv = (log, { context = true } = {}) => {
  const canvas = {
    getContext: () => (context ? { drawImage: (...args) => log.drawn.push(args.slice(1)) } : null),
    toBlob: (resolve, type) => { log.encoded.push(type); resolve(new Blob(['x'], { type })); },
  };
  return { document: { createElement: () => canvas }, canvas };
};

const flatten = async (t, { width, height, blob, context }) => {
  const log = { drawn: [], encoded: [] };
  const env = fakeCanvasEnv(log, { context });
  installGlobals(t, { Image: decodedImage(width, height), document: env.document });
  const result = await flattenToStillImage(blob);
  return { result, log, canvas: env.canvas };
};

test('a legacy PNG is redrawn as a PNG still with its long edge bounded', async (t) => {
  const { result, log, canvas } = await flatten(t, { width: 4000, height: 2000, blob: apngBlob() });
  assert.equal(result.type, 'image/png');
  assert.deepEqual(log.encoded, ['image/png']);
  assert.deepEqual([canvas.width, canvas.height], [1200, 600]);
  assert.deepEqual(log.drawn, [[0, 0, 1200, 600]]);
});

test('JPEG stays JPEG and GIF or WebP become PNG', async (t) => {
  assert.equal((await flatten(t, { width: 10, height: 10, blob: new Blob(['j'], { type: 'image/jpeg' }) })).result.type, 'image/jpeg');
  for (const type of ['image/gif', 'image/webp']) {
    assert.equal((await flatten(t, { width: 10, height: 10, blob: new Blob(['g'], { type }) })).result.type, 'image/png');
  }
});

test('an image the browser cannot draw yields null, and a decode failure rejects', async (t) => {
  assert.equal((await flatten(t, { width: 0, height: 0, blob: apngBlob() })).result, null);
  assert.equal((await flatten(t, { width: 10, height: 10, blob: apngBlob(), context: false })).result, null);
  installGlobals(t, { Image: decodedImage(1, 1, true) });
  await assert.rejects(flattenToStillImage(apngBlob()), /could not be decoded/);
});
