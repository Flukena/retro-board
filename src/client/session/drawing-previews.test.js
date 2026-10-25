import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { createDrawingPreviews } from './drawing-previews.js';
const stroke = points => ({ tool: 'pen', color: '#112233', width: 4, points });
const preview = strokes => ({ id: 'session', targetId: null, base: null, strokes });
test('a live drag sends incremental points, excludes its owner and unfinished ink from board/history, and clears disconnected peers', () => {
  const first = new Y.Doc(), second = new Y.Doc(), a = new Awareness(first), b = new Awareness(second);
  const sender = createDrawingPreviews(first, a), receiver = createDrawingPreviews(second, b);
  try {
    a.setLocalState({ user: { name: 'Fixture' } });
    applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), 'peer');
    const points = Array.from({ length: 500 }, (_, index) => ({ x: index, y: 100 }));
    sender.publish(preview([stroke(points)]), true); Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    assert.equal(sender.getSnapshot().length, 0); assert.equal(receiver.getSnapshot()[0].strokes[0].points.length, 500);
    assert.equal(second.getMap('items').size, 0);
    const stable = receiver.getSnapshot(); let notifications = 0;
    const unsubscribe = receiver.subscribe(() => notifications++);
    a.setLocalState({ user: { name: 'Fixture' }, cursor: { x: 5, y: 10 } });
    applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), 'peer');
    receiver.publish(preview([stroke([{ x: 0, y: 0 }])]), true);
    assert.equal(notifications, 0, 'Cursor motion and own drawing must not repaint remote previews');
    assert.equal(receiver.getSnapshot(), stable); unsubscribe(); receiver.clear();
    const vector = Y.encodeStateVector(second);
    sender.publish(preview([stroke([...points, { x: 501, y: 100 }])]), true);
    const delta = Y.encodeStateAsUpdate(first, vector); assert.ok(delta.length < 200, 'One new point must not retransmit the complete path');
    Y.applyUpdate(second, delta); assert.equal(receiver.getSnapshot()[0].strokes[0].points.length, 501);
    sender.publish(preview([]), true); Y.applyUpdate(second, Y.encodeStateAsUpdate(first, Y.encodeStateVector(second)));
    assert.deepEqual(receiver.getSnapshot(), []);
    sender.publish(preview([stroke([{ x: 1, y: 2 }])]), true); Y.applyUpdate(second, Y.encodeStateAsUpdate(first, Y.encodeStateVector(second)));
    a.setLocalState(null); applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [a.clientID]), 'peer');
    assert.deepEqual(receiver.getSnapshot(), []);
  } finally { sender.destroy(); receiver.destroy(); a.destroy(); b.destroy(); first.destroy(); second.destroy(); }
});

test('canonical deletion removes the peer preview even when the drawing owner remains connected, including hydrated orphans', () => {
  const first=new Y.Doc(),second=new Y.Doc(),a=new Awareness(first),b=new Awareness(second);
  const sender=createDrawingPreviews(first,a),receiver=createDrawingPreviews(second,b);
  try {
    a.setLocalState({user:{name:'Fixture'}});applyAwarenessUpdate(b,encodeAwarenessUpdate(a,[a.clientID]),'peer');
    first.getMap('items').set('drawing',new Y.Map(Object.entries({id:'drawing',type:'image',src:'saved.png',x:0,y:0,w:100,h:100})));
    sender.publish({...preview([stroke([{x:10,y:20}])]),targetId:'drawing'},true);Y.applyUpdate(second,Y.encodeStateAsUpdate(first));
    assert.equal(receiver.getSnapshot().length,1);
    second.getMap('items').delete('drawing');
    assert.equal(receiver.getSnapshot().length,0,'Deleted canonical images must not leave an unselectable canvas');
    assert.equal(b.getStates().has(a.clientID),true,'The owner may still have the drawing tool open');
    sender.publish({...preview([stroke([{x:10,y:20},{x:20,y:30}])]),targetId:'drawing'},true);
    Y.applyUpdate(second,Y.encodeStateAsUpdate(first,Y.encodeStateVector(second)));
    assert.equal(receiver.getSnapshot().length,0,'Late preview updates must not resurrect a deleted image');
  }finally{sender.destroy();receiver.destroy();a.destroy();b.destroy();first.destroy();second.destroy();}
});

test('target deletion subscriptions detach safely and ignore unrelated item changes', () => {
  const doc=new Y.Doc(),awareness=new Awareness(doc),bridge=createDrawingPreviews(doc,awareness);let removed=0;
  try {
    const items=doc.getMap('items');items.set('drawing',new Y.Map());items.set('other',new Y.Map());
    const off=bridge.watchTargetDeletion('drawing',()=>{removed++;});items.delete('other');assert.equal(removed,0);
    items.delete('drawing');assert.equal(removed,1);off();off();
    items.set('drawing',new Y.Map());bridge.watchTargetDeletion('drawing',()=>{removed++;});off();
    items.delete('drawing');assert.equal(removed,2,'An old unsubscribe cannot remove a newer subscription');
  }finally{bridge.destroy();awareness.destroy();doc.destroy();}
});
