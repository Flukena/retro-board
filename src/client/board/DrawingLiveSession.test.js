import test from 'node:test';
import assert from 'node:assert/strict';
import { DrawingDraft } from '../../domain/freehand-drawing.js';
import { DrawingLiveSession } from './DrawingLiveSession.js';
function fixture() {
  const draft = new DrawingDraft(); let items = [], uploads = 0, errors = [];
  const ctx = {};
  for (const name of ['setTransform', 'clearRect', 'beginPath', 'arc', 'fill', 'moveTo', 'lineTo', 'stroke']) ctx[name] = () => {};
  const canvas = { getContext: () => ctx, toBlob: (done, type) => done(new Blob(['png'], { type })) };
  const operations = { createId: () => 'drawing', previews: () => null, items: () => items,
    canEdit: () => true, zoom: () => 1, document: () => ({ createElement: () => canvas }), baseImage: () => null,
    author: () => ({ authorId: 'owner', authorName: 'Owner' }), uploadImage: async () => `saved-${++uploads}.png`,
    stopUndoCapture() {}, addItem: item => { items.push(item); return true; },
    updateItem: (id, patch) => { items = items.map(item => item.id === id ? { ...item, ...patch } : item); return true; },
    removeItem: id => { items = items.filter(item => item.id !== id); }, selectItem() {},
    error: value => errors.push(value), saving() {}, changed() {} };
  const session = new DrawingLiveSession(draft, operations);
  const stroke = () => { draft.begin({ x: 10, y: 20 }, { color: '#112233', width: 4 }); draft.end(); session.changed(); };
  return { session, draft, operations, stroke, items: () => items, errors: () => errors, uploads: () => uploads };
}
test('automatic checkpoints update one image, support Undo-all/Redo and close without adding duplicate saves', async () => {
  const f = fixture();
  try {
    f.stroke(); assert.equal(await f.session.autosave.flush(), true); assert.equal(f.items().length, 1);
    f.stroke(); assert.equal(await f.session.autosave.flush(), true); assert.equal(f.items().length, 1); assert.equal(f.uploads(), 2);
    f.draft.undo(); f.draft.undo(); f.session.changed(); await f.session.autosave.flush(); assert.equal(f.items().length, 0);
    f.draft.redo(); f.session.changed(); await f.session.autosave.flush(); assert.equal(f.items()[0].id, 'drawing');
    assert.equal(await f.session.close(), true); assert.equal(f.uploads(), 3);
  } finally { f.session.dispose(); }
});
test('discarding a pending upload and a peer replacing its target never overwrite canonical items', async () => {
  const f = fixture(); let resolve;
  try {
    f.operations.uploadImage = () => new Promise(done => { resolve = done; });
    f.stroke(); const pending = f.session.autosave.flush();
    await new Promise(done => setImmediate(done)); f.session.discard(); resolve('late.png');
    assert.equal(await pending, false); assert.equal(f.items().length, 0);
  } finally { f.session.dispose(); }
  const g = fixture();
  try {
    g.stroke(); await g.session.autosave.flush(); g.items()[0].src = 'peer.png';
    g.stroke(); assert.equal(await g.session.autosave.flush(), false);
    assert.equal(g.items()[0].src, 'peer.png'); assert.equal(g.uploads(), 1); assert.equal(g.errors().at(-1), 'draw.conflict');
  } finally { g.session.dispose(); }
});

test('an automatic checkpoint removes the completed preview and does not republish it when the pointer is idle', async () => {
  const f=fixture();let active=null;
  f.operations.previews=()=>({publish:value=>{active=typeof value==='function'?value():value;},clear:()=>{active=null;}});
  try {
    f.stroke();assert.ok(active);
    await f.session.autosave.flush();
    assert.equal(active,null,'Saved PNG must be selectable rather than hidden by a completed preview');
    f.session.changed();assert.equal(active,null,'Blur/pan must not restore already-saved ink');
  }finally{f.session.dispose();}
});

test('deletion while another checkpoint is uploading clears own ink and prevents a late image resurrection', async () => {
  const f=fixture();let watcher=null,removed=0,resolve;
  f.operations.previews=()=>({publish(){},clear(){},watchTargetDeletion:(id,listener)=>{watcher=id?listener:null;return()=>{watcher=null;};}});
  f.operations.removed=()=>{removed++;};
  try {
    f.stroke();await f.session.autosave.flush();assert.ok(watcher);
    f.operations.uploadImage=()=>new Promise(done=>{resolve=done;});
    f.stroke();const pending=f.session.autosave.flush();await new Promise(done=>setImmediate(done));
    f.operations.removeItem('drawing');watcher();resolve('late.png');
    assert.equal(await pending,false);assert.equal(f.items().length,0);assert.equal(f.draft.empty,true);assert.equal(removed,1);
    assert.equal(await f.session.close(),true,'Owner must be able to leave the invalidated editor');
  }finally{f.session.dispose();}
});
test('a checkpoint finishing during the next pointer gesture retains that unfinished live preview', async () => {
  const f=fixture();let active=null,resolve;
  f.operations.previews=()=>({publish:value=>{active=typeof value==='function'?value():value;},clear:()=>{active=null;}});
  try {
    f.operations.uploadImage=()=>new Promise(done=>{resolve=done;});f.stroke();const pending=f.session.autosave.flush();
    await new Promise(done=>setImmediate(done));f.draft.begin({x:30,y:40},{color:'#112233',width:4});f.session.preview();
    resolve('first.png');assert.equal(await pending,true);assert.equal(active.strokes.length,2);
    f.draft.cancelStroke();f.session.changed();assert.equal(active,null,'Cancelling the next gesture reveals the already-saved PNG');
  }finally{f.session.dispose();}
});
