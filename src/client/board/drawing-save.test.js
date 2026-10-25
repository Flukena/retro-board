import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDrawingArtifact } from './drawing-save.js';
const artifact = { blob: new Blob(['png'], { type: 'image/png' }), bounds: { x: 10.25, y: 20.5, w: 1600, h: 500 }, natW: 1200, natH: 375 };
function fixture() {
  const added = [], selected = []; let boundaries = 0, failures = 0;
  const operations = { isCurrent: () => true, canEdit: () => true, uploadImage: async () => '/rooms/fixture/images/drawing.png', uploadFailed: () => { failures++; },
    author: () => ({ authorId: 'a', authorName: 'Ada' }), createId: () => 'drawing', now: () => 1000, items: () => [],
    stopUndoCapture: () => { boundaries++; }, addItem: item => { added.push(item); return true; }, selectItem: id => selected.push(id) };
  return { operations, added, selected, boundaries: () => boundaries, failures: () => failures };
}
test('saving preserves drawn size instead of applying the ordinary480px image cap, and creates one undo step', async () => {
  const f = fixture(); assert.equal(await saveDrawingArtifact(artifact, f.operations), true);
  assert.equal(f.added.length, 1); assert.equal(f.added[0].w, 1600); assert.equal(f.added[0].x, 10.25);
  assert.equal(f.added[0].type, 'image'); assert.equal(f.added[0].parentZoneId, null); assert.equal(f.boundaries(), 2); assert.deepEqual(f.selected, ['drawing']);
});
test('cancel or permission loss during upload cannot add/select a ghost drawing', async () => {
  for (const guard of ['isCurrent', 'canEdit']) {
    const f = fixture(); let resolve; f.operations.uploadImage = () => new Promise(done => { resolve = done; });
    const saving = saveDrawingArtifact(artifact, f.operations); f.operations[guard] = () => false; resolve('uploaded');
    assert.equal(await saving, false); assert.equal(f.added.length, 0); assert.equal(f.selected.length, 0);
  }
});
test('upload and rejected writes leave draft ownership with caller and never select nonexistent items', async () => {
  const f = fixture(); f.operations.uploadImage = async () => { throw new Error('image upload failed: 429'); };
  assert.equal(await saveDrawingArtifact(artifact, f.operations), false); assert.equal(f.failures(), 1); assert.equal(f.added.length, 0);
  f.operations.uploadImage = async () => 'uploaded'; f.operations.addItem = () => false;
  assert.equal(await saveDrawingArtifact(artifact, f.operations), false); assert.equal(f.selected.length, 0);
});

test('editing a saved drawing updates its existing ID in one undo boundary without creating another image', async () => {
  const f=fixture(), target={id:'existing',type:'image',src:'before.png',x:1,y:2,w:100,h:80,authorName:'original'};
  const updates=[]; f.operations.items=()=>[target]; f.operations.updateItem=(id,patch)=>{updates.push({id,patch});return true;};
  assert.equal(await saveDrawingArtifact(artifact,f.operations,target),true);
  assert.equal(f.added.length,0); assert.equal(updates.length,1); assert.equal(updates[0].id,target.id);
  assert.equal(updates[0].patch.authorName,undefined); assert.equal(updates[0].patch.w,1600); assert.equal(f.boundaries(),2);
});
test('a collaborator replacing or deleting a target during upload prevents stale image overwrite and selection', async () => {
  const target={id:'existing',type:'image',src:'before.png',x:1,y:2,w:100,h:80};
  for(const after of [[],[{...target,src:'peer.png'}],[{...target,x:50}]]) {
    const f=fixture();let current=[target],resolve; f.operations.items=()=>current;
    f.operations.uploadImage=()=>new Promise(done=>{resolve=done;}); f.operations.updateItem=()=>assert.fail('must not overwrite peer change');
    const saving=saveDrawingArtifact(artifact,f.operations,target); current=after; resolve('new.png');
    assert.equal(await saving,false); assert.deepEqual(f.selected,[]);
  }
});
