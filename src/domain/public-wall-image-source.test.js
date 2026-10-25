import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPublicImageSource } from './public-wall-image-source.js';

const HANDLE = 'a'.repeat(32);
const IMAGE_PATH = `/rooms/${HANDLE}/images/12345678-abcd.png`;
const PUBLIC_PATH = `/yjs-public${IMAGE_PATH}`;

test('public image sources retain only canonical own-origin room-bound raster paths', () => {
  for (const value of [IMAGE_PATH, PUBLIC_PATH, `https://uploads.example${IMAGE_PATH}`, `http://localhost:1235${PUBLIC_PATH}`]) {
    assert.equal(canonicalPublicImageSource(value, HANDLE), PUBLIC_PATH);
    assert.equal(canonicalPublicImageSource(value), PUBLIC_PATH);
  }
  assert.equal(canonicalPublicImageSource(IMAGE_PATH, 'b'.repeat(32)), null);
  assert.equal(canonicalPublicImageSource(IMAGE_PATH, 'invalid'), null);
});

test('public image sources reject private, legacy, embedded and URL ambiguity without fetching', () => {
  const invalid = [null, {}, '', `/yjs${IMAGE_PATH}`, '/images/12345678.png',
    `//evil.example${IMAGE_PATH}`, `https://user:password@evil.example${IMAGE_PATH}`,
    `${IMAGE_PATH}?track=1`, `${IMAGE_PATH}#fragment`, `${IMAGE_PATH}.svg`,
    IMAGE_PATH.replace('12345678-abcd', 'bad'), IMAGE_PATH.replace('/images/', '/%69mages/'),
    `/other/..${IMAGE_PATH}`, `https://evil.example/other/..${IMAGE_PATH}`,
    `https://evil.example\\${IMAGE_PATH}`, ` ${IMAGE_PATH}`, `${IMAGE_PATH}\n`,
    PUBLIC_PATH.replace('yjs-public', 'YJS-PUBLIC'),
    'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://tracker.example/pixel.png'];
  for (const value of invalid) assert.equal(canonicalPublicImageSource(value, HANDLE), null, String(value));
});
