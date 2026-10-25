import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_SOURCE_MAX_DIMENSION,
  classifyImportedImageSource,
  imageInfoIsWithinLimits,
  inspectRasterImageBytes,
  normalizeRuntimeImageSource,
  redactBoardExportForViewer,
  shouldReencodeImageMime,
  stickyTextForDom,
} from './security-boundaries.js';

const IMAGE_ID = 'f98dcb70-f794-4b1a-9d4d-09fd5b4cd9a4';
const ROOM_HANDLE = 'aB3_dE6-gH9_jK2-mN5_pQ8-sT1_vW4-'.slice(0, 32);

test('hidden sticky text is omitted instead of returned for DOM rendering', () => {
  const sticky = { id: 'sticky-1', type: 'sticky', text: 'private planning note' };
  assert.equal(stickyTextForDom(sticky, true), null);
  assert.equal(stickyTextForDom(sticky, false), 'private planning note');
});

test('JSON export redacts hidden sticky text and its comments without mutating live state', () => {
  const items = [
    { id: 'secret', type: 'sticky', text: 'private planning note', private: true },
    { id: 'visible', type: 'sticky', text: 'public note' },
    { id: 'zone', type: 'zone', title: 'Keep me' },
  ];
  const comments = {
    secret: [{ id: 'comment-secret', text: 'private follow-up' }],
    visible: [{ id: 'comment-visible', text: 'public follow-up' }],
  };

  const redacted = redactBoardExportForViewer(
    items,
    comments,
    (item) => item.id === 'secret',
  );

  assert.equal(redacted.items[0].text, '');
  assert.equal(redacted.items[1].text, 'public note');
  assert.equal(redacted.items[2], items[2]);
  assert.deepEqual(redacted.comments, { visible: comments.visible });
  assert.doesNotMatch(JSON.stringify(redacted), /private planning note|private follow-up/);
  assert.equal(items[0].text, 'private planning note');
  assert.equal(comments.secret[0].text, 'private follow-up');
});

test('imported image sources allow only raster data or server image routes', () => {
  assert.equal(classifyImportedImageSource(`/images/${IMAGE_ID}.png`)?.kind, 'server');
  assert.equal(classifyImportedImageSource(`https://retro.example/yjs/images/${IMAGE_ID}.jpg`)?.kind, 'server');
  assert.equal(classifyImportedImageSource(`/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}.webp`)?.kind, 'server');
  assert.equal(classifyImportedImageSource(`https://retro.example/yjs/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}.gif`)?.kind, 'server');
  assert.equal(classifyImportedImageSource('data:image/png;base64,iVBORw==')?.kind, 'data');

  const rejected = [
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png,%89PNG',
    'https://retro.example/avatar.png',
    `https://retro.example/images/${IMAGE_ID}.png?track=1`,
    `https://user:password@retro.example/images/${IMAGE_ID}.png`,
    `/rooms/${'a'.repeat(31)}/images/${IMAGE_ID}.png`,
    `/rooms/${ROOM_HANDLE}/images/not-an-image.svg`,
  ];
  rejected.forEach((source) => assert.equal(classifyImportedImageSource(source), null, source));
});

test('runtime image URLs stay on the page or configured relay origin', () => {
  const options = {
    pageOrigin: 'https://retro.example',
    relayBaseUrl: 'https://retro.example/yjs/',
    roomHandle: ROOM_HANDLE,
  };
  assert.equal(
    normalizeRuntimeImageSource(`/images/${IMAGE_ID}.png`, options),
    `https://retro.example/yjs/images/${IMAGE_ID}.png`,
  );
  assert.equal(
    normalizeRuntimeImageSource(`https://retro.example/yjs/images/${IMAGE_ID}.png`, options),
    `https://retro.example/yjs/images/${IMAGE_ID}.png`,
  );
  assert.equal(
    normalizeRuntimeImageSource(`/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}.png`, options),
    `https://retro.example/yjs/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}.png`,
  );
  assert.equal(
    normalizeRuntimeImageSource(
      `https://retro.example/yjs/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}.png`,
      options,
    ),
    `https://retro.example/yjs/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}.png`,
  );
  assert.equal(
    normalizeRuntimeImageSource(
      `https://retro.example/yjs/rooms/${'z'.repeat(32)}/images/${IMAGE_ID}.png`,
      options,
    ),
    null,
  );
  assert.equal(
    normalizeRuntimeImageSource(`https://tracker.example/images/${IMAGE_ID}.png`, options),
    null,
  );
});

test('raster header inspection enforces dimensions and rejects animated WebP', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(png.buffer);
  view.setUint32(16, 640);
  view.setUint32(20, 480);
  const info = inspectRasterImageBytes(png, 'image/png');
  assert.deepEqual(info, { mime: 'image/png', width: 640, height: 480, frameCount: 1 });
  assert.equal(imageInfoIsWithinLimits(info), true);

  view.setUint32(16, IMAGE_SOURCE_MAX_DIMENSION + 1);
  assert.equal(imageInfoIsWithinLimits(inspectRasterImageBytes(png, 'image/png')), false);

  const animatedWebp = new Uint8Array(30);
  animatedWebp.set(Buffer.from('RIFF'), 0);
  animatedWebp.set(Buffer.from('WEBP'), 8);
  animatedWebp.set(Buffer.from('VP8X'), 12);
  animatedWebp[20] = 0x02;
  assert.equal(imageInfoIsWithinLimits(inspectRasterImageBytes(animatedWebp, 'image/webp')), false);
  assert.equal(shouldReencodeImageMime('image/png'), true);
  assert.equal(shouldReencodeImageMime('image/gif'), false);
});

test('GIF inspection counts frames before allowing animation through unchanged', () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const info = inspectRasterImageBytes(gif, 'image/gif');
  assert.deepEqual(info, {
    mime: 'image/gif', width: 1, height: 1, frameCount: 1, totalFramePixels: 1,
  });
  assert.equal(imageInfoIsWithinLimits(info), true);
  assert.equal(inspectRasterImageBytes(gif.subarray(0, -1), 'image/gif'), null);
});

test('public runtime image URLs stay within their own relay prefix and room', () => {
  const path = `/yjs-public/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}.png`;
  const options = { pageOrigin: 'https://retro.example', relayBaseUrl: 'https://retro.example/yjs-public/', roomHandle: ROOM_HANDLE };
  assert.equal(classifyImportedImageSource(path)?.kind, 'server');
  assert.equal(normalizeRuntimeImageSource(path, options), `https://retro.example${path}`);
  assert.equal(normalizeRuntimeImageSource(`/rooms/${ROOM_HANDLE}/images/${IMAGE_ID}.png`, options), `https://retro.example${path}`);
  for (const source of [path.replace(ROOM_HANDLE, 'z'.repeat(32)), path.replace('/yjs-public/', '/yjs/'), `/images/${IMAGE_ID}.png`, `https://tracker.example${path}`]) {
    assert.equal(normalizeRuntimeImageSource(source, options), null, source);
  }
  assert.equal(normalizeRuntimeImageSource(path, { ...options, relayBaseUrl: 'https://retro.example/yjs/' }), null);
});

test('PNG animation chunks are rejected without mistaking compressed payload text for animation', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const pngHeaderEndBytes = 33;
  const chunkOverheadBytes = 12;
  const chunkTypeOffsetBytes = 4;
  const chunkDataOffsetBytes = 8;
  const animationPayloadBytes = 8;
  const chunk = Buffer.alloc(chunkOverheadBytes + animationPayloadBytes);
  chunk.writeUInt32BE(animationPayloadBytes);
  for (const type of ['acTL', 'fcTL', 'fdAT']) {
    chunk.write(type, chunkTypeOffsetBytes);
    const animated = Buffer.concat([png.subarray(0, pngHeaderEndBytes), chunk, png.subarray(pngHeaderEndBytes)]);
    const info = inspectRasterImageBytes(animated, 'image/png');
    assert.equal(info.animated, true);
    assert.equal(imageInfoIsWithinLimits(info), false);
  }
  chunk.write('IDAT', chunkTypeOffsetBytes);
  chunk.write('acTL', chunkDataOffsetBytes);
  const staticPng = Buffer.concat([png.subarray(0, pngHeaderEndBytes), chunk, png.subarray(pngHeaderEndBytes)]);
  assert.equal(imageInfoIsWithinLimits(inspectRasterImageBytes(staticPng, 'image/png')), true);
});
