import test from 'node:test';
import assert from 'node:assert/strict';
import { stickyTextEditPatch } from './sticky-editor.js';

const STICKY = { type: 'sticky', text: 'current idea', authorId: 'author' };
const CONTRIBUTOR = { userId: 'visitor', name: 'Visitor' };
const TEXT_EDIT = { text: 'updated idea' };

test('only a real change to sticky text records a foreign editor', () => {
  assert.deepEqual(stickyTextEditPatch(STICKY, TEXT_EDIT, CONTRIBUTOR), { ...TEXT_EDIT, lastEditor: CONTRIBUTOR });
  const resize = { h: 200 };
  assert.equal(stickyTextEditPatch(STICKY, resize, CONTRIBUTOR), resize);
  const unchanged = { text: STICKY.text };
  assert.equal(stickyTextEditPatch(STICKY, unchanged, CONTRIBUTOR), unchanged);
  assert.equal(stickyTextEditPatch({ ...STICKY, type: 'text' }, TEXT_EDIT, CONTRIBUTOR), TEXT_EDIT);
});

test('an owner or unidentified editor clears an earlier contributor on text changes', () => {
  const previous = { ...STICKY, lastEditor: CONTRIBUTOR };
  assert.deepEqual(stickyTextEditPatch(previous, TEXT_EDIT, { userId: 'author', name: 'Author' }),
    { ...TEXT_EDIT, lastEditor: undefined });
  assert.deepEqual(stickyTextEditPatch(previous, TEXT_EDIT),
    { ...TEXT_EDIT, lastEditor: undefined });
  assert.equal(stickyTextEditPatch(previous, TEXT_EDIT, CONTRIBUTOR), TEXT_EDIT);
});
