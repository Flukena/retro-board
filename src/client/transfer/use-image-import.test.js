import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from './use-image-import.js';
import { IMAGE_MAX_BYTES, isSafeImageMime } from '../../domain/security-boundaries.js';
import { IMAGE_MAX_MIB_LABEL, canStartImageImport } from './image-upload.js';

function harness(overrides = {}) {
  const calls = [];
  const prepared = { blob: { type: 'image/png' }, nw: 320, nh: 240 };
  const storage = {
    uploadImage(blob) { assert.equal(this, storage); calls.push(['upload', blob]); return '/rooms/test/images/img'; },
    canCreateItems() { assert.equal(this, storage); return true; },
  };
  const options = { canStartImageImport, window: { storage }, isSafeImageMime, IMAGE_MAX_BYTES, IMAGE_MAX_MIB_LABEL,
    setToast: value => calls.push(['toast', value]), t: (key, args) => ({ key, ...args }),
    prepareImageBlob: async () => prepared, addImage: (...args) => calls.push(['add', ...args]), ...overrides };
  return { calls, prepared, controller: createController(options) };
}
const image = { type: 'image/png', size: 100 };

test('prepared image uploads before creation with original world position and decoded dimensions', async () => {
  const h = harness();
  await h.controller.importImageFromBlob(image, 80, 90);
  assert.deepEqual(h.calls, [['upload', h.prepared.blob], ['add', 80, 90, '/rooms/test/images/img', 320, 240]]);
  h.controller.dispose();
});

test('non-images and creation quota rejection do not prepare, upload or create', async () => {
  for (const [blob, overrides] of [[{ type: 'text/plain' }, {}], [image, { window: { storage: { canCreateItems: () => false } } }]]) {
    const h = harness({ prepareImageBlob: () => assert.fail('must not prepare'), ...overrides });
    await h.controller.importImageFromBlob(blob, 0, 0);
    assert.deepEqual(h.calls, []);
  }
});

test('unsafe MIME and oversized blobs warn before preparation', async () => {
  for (const [blob, key] of [[{ type: 'image/svg+xml', size: 10 }, 'image.unsupportedFormat'],
    [{ ...image, size: IMAGE_MAX_BYTES + 1 }, 'image.tooLarge']]) {
    const h = harness({ prepareImageBlob: () => assert.fail('must not prepare') });
    await h.controller.importImageFromBlob(blob, 0, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][1].msg.key, key);
    assert.equal(h.calls[0][1].type, 'warn');
  }
});

test('failed decode and upload never create an image', async () => {
  for (const overrides of [{ prepareImageBlob: async () => null },
    { prepareImageBlob: async () => { throw new Error('decode'); } },
    { window: { storage: { uploadImage: async () => { throw new Error('network'); } } } }]) {
    const h = harness(overrides);
    await h.controller.importImageFromBlob(image, 0, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], 'toast');
    assert.equal(h.calls[0][1].msg.key, overrides.window ? 'image.uploadFailed' : 'image.tooLarge');
  }
});
