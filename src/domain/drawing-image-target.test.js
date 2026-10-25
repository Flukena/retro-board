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
