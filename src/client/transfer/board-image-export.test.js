import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSceneImages } from './board-image-export.js';

class FakeImage {
  src = '';
  decode() { return this.src.includes('broken') ? Promise.reject(new Error('bad image')) : Promise.resolve(); }
}
const fakeDocument = { defaultView: { Image: FakeImage } };

test('room images are drawn from a blob URL fetched with the room session', async () => {
  const requested = [];
  const readImage = async (url) => { requested.push(url); return new Blob(['png'], { type: 'image/png' }); };
  const { images, failed } = await loadSceneImages(fakeDocument, ['/rooms/r/images/a.png'], readImage);
  assert.deepEqual(requested, ['/rooms/r/images/a.png']);
  assert.equal(failed, 0);
  assert.match(images.get('/rooms/r/images/a.png').src, /^blob:/);
});

test('data URLs decode directly without a network read', async () => {
  const readImage = async () => assert.fail('data URLs must not be fetched');
  const { images } = await loadSceneImages(fakeDocument, ['data:image/png;base64,AA=='], readImage);
  assert.equal(images.get('data:image/png;base64,AA==').src, 'data:image/png;base64,AA==');
});

test('an image that cannot be read is left out and counted, the rest still load', async () => {
  const readImage = async (url) => {
    if (url.includes('gone')) throw new Error('image read failed: 404');
    return new Blob(['png']);
  };
  const urls = ['/rooms/r/images/gone.png', '/rooms/r/images/ok-1.png', 'data:broken', '/rooms/r/images/ok-2.png'];
  const { images, failed } = await loadSceneImages(fakeDocument, urls, readImage);
  assert.equal(failed, 2);
  assert.deepEqual([...images.keys()].sort(), ['/rooms/r/images/ok-1.png', '/rooms/r/images/ok-2.png']);
});
