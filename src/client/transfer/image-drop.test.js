import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allowCanvasFileDrop,
  dragClientPoint,
  droppedImageBlobs,
  resolveDropClientPoint,
  shouldDownscaleImage,
} from './image-drop.js';

test('allows a Finder drag even when dragover does not advertise Files', () => {
  let prevented = false;
  const event = {
    dataTransfer: { types: ['text/uri-list'], dropEffect: 'none' },
    preventDefault: () => { prevented = true; },
  };

  allowCanvasFileDrop(event);

  assert.equal(prevented, true);
  assert.equal(event.dataTransfer.dropEffect, 'copy');
});

test('uses the last dragover position when Finder reports drop at 0,0', () => {
  const lastDragPoint = { x: 640, y: 360 };
  assert.deepEqual(
    resolveDropClientPoint({ clientX: 0, clientY: 0 }, lastDragPoint),
    lastDragPoint,
  );
});

test('keeps a valid drop position instead of replacing it with dragover', () => {
  assert.deepEqual(
    resolveDropClientPoint({ clientX: 700, clientY: 420 }, { x: 640, y: 360 }),
    { x: 700, y: 420 },
  );
  assert.equal(dragClientPoint({ clientX: undefined, clientY: 20 }), null);
});

test('recognizes a Finder image with an empty MIME type from its extension', () => {
  const file = {
    name: 'retro.PNG',
    type: '',
    size: 69,
    slice(start, end, type) {
      return { original: this, size: end - start, type };
    },
  };

  const blobs = droppedImageBlobs({ files: [file] });

  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, 'image/png');
  assert.equal(blobs[0].original, file);
});

test('does not accept unsupported files by extension', () => {
  const file = { name: 'photo.heic', type: '', size: 100 };
  assert.deepEqual(droppedImageBlobs({ files: [file] }), []);
});

test('recognizes a Finder GIF with an empty MIME type', () => {
  const file = {
    name: 'reaction.GIF',
    type: '',
    size: 200,
    slice(start, end, type) {
      return { size: end - start, type };
    },
  };

  const [blob] = droppedImageBlobs({ files: [file] });
  assert.equal(blob.type, 'image/gif');
});

test('does not flatten an animated GIF while preparing it for upload', () => {
  assert.equal(shouldDownscaleImage('image/gif', 2400, 1200), false);
  assert.equal(shouldDownscaleImage('image/png', 2400, 1200), true);
});
