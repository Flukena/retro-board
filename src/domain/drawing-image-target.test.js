import test from 'node:test';
import assert from 'node:assert/strict';
import { isEditableDrawingImage, drawingTargetUnchanged } from './drawing-image-target.js';
const image = { id:'image', type:'image', src:'/rooms/drawing.png', x:1, y:2, w:100, h:80, natW:100, natH:80 };
test('saved PNG drawings can reopen but animated and unrelated item kinds do not flatten accidentally', () => {
  assert.equal(isEditableDrawingImage(image), true);
  for (const item of [{...image,src:'animation.gif'},{...image,type:'sticky'},null]) assert.equal(isEditableDrawingImage(item), false);
});
test('deleted/replaced/moved/resized targets reject stale edits while unrelated author metadata is preserved', () => {
  assert.equal(drawingTargetUnchanged(image,[]), false);
  for (const field of ['src','x','y','w','h','natW','natH']) assert.equal(drawingTargetUnchanged(image,[{...image,[field]:field==='src'?'new.png':50}]),false);
  assert.equal(drawingTargetUnchanged(image,[{...image,authorName:'peer'}]),true);
});

test('an encrypted-room image source is editable like a .png, but only its own canonical form', () => {
  const base = { type: 'image', x: 0, y: 0, w: 100, h: 80 };
  const src = `/rooms/${'a'.repeat(32)}/e2e-blobs/3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b`;
  assert.equal(isEditableDrawingImage({ ...base, src }), true);
  assert.equal(isEditableDrawingImage({ ...base, src: `${src}.gif` }), false);
  assert.equal(isEditableDrawingImage({ ...base, src: src.replace('4e6f', '1e6f') }), false);
  const target = { id: 'd', ...base, src, natW: 1, natH: 1 };
  assert.equal(drawingTargetUnchanged(target, [target]), true);
});
