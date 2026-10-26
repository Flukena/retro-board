import test from 'node:test';
import assert from 'node:assert/strict';
import { OverviewRasterImage } from './overview-raster-image.js';

function fixture() {
  const pending = [];
  const canvas = { width: 300, height: 200, toBlob: callback => pending.push(callback) };
  const created = [], revoked = [], changes = [];
  let next = 0;
  const urlApi = {
    createObjectURL: blob => { const url = `blob:${++next}:${blob}`; created.push(url); return url; },
    revokeObjectURL: url => revoked.push(url),
  };
  const image = new OverviewRasterImage(canvas, { urlApi, onChange: url => changes.push(url) });
  return { canvas, image, pending, created, revoked, changes };
}

test('only the newest export reaches the image', () => {
  const { image, pending, changes, created } = fixture();
  image.publish(); image.publish();
  pending[1]('second'); pending[0]('first');
  assert.deepEqual(changes, ['blob:1:second']);
  assert.equal(created.length, 1, 'A stale export must not create an object URL');
});

test('the shown URL stays alive until a newer one has loaded, then it is revoked', () => {
  const { image, pending, changes, revoked } = fixture();
  image.publish(); pending[0]('a');
  assert.equal(image.loaded(changes[0]), true);
  image.publish(); pending[1]('b');
  assert.deepEqual(revoked, [], 'The visible image must not lose its URL before the next one loads');
  assert.equal(image.loaded(changes[1]), true);
  assert.deepEqual(revoked, [changes[0]]);
});

test('an export that never loaded is revoked when a newer one replaces it', () => {
  const { image, pending, changes, revoked } = fixture();
  image.publish(); pending[0]('a');
  image.publish(); pending[1]('b');
  assert.deepEqual(revoked, [changes[0]]);
  assert.equal(image.loaded(changes[0]), false, 'A replaced URL must not be reported as current');
});

test('dispose revokes every URL, frees the canvas and ignores late exports', () => {
  const { image, canvas, pending, changes, revoked } = fixture();
  image.publish(); pending[0]('a'); image.loaded(changes[0]);
  image.publish(); pending[1]('b');
  image.publish();
  image.dispose();
  assert.deepEqual(revoked.sort(), [changes[0], changes[1]].sort());
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  pending[2]('late');
  assert.equal(changes.length, 2);
});

test('a failed export leaves the current image in place', () => {
  const { image, pending, changes } = fixture();
  image.publish(); pending[0](null);
  assert.deepEqual(changes, []);
});
