import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { createMotionPublisher, sendOnlyLocalAwareness } from './awareness-transport.js';

test('real provider sends local awareness but never echoes remote updates', () => {
  const doc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const remote = new Awareness(remoteDoc);
  const provider = new WebsocketProvider('ws://localhost', 'test', doc, { connect: false });
  sendOnlyLocalAwareness(provider);
  const frames = [];
  provider.wsconnected = true;
  provider.ws = { send: (frame) => frames.push(frame), close() {} };
  try {
    remote.setLocalStateField('user', { userId: 'remote' });
    applyAwarenessUpdate(provider.awareness, encodeAwarenessUpdate(remote, [remoteDoc.clientID]), provider);
    assert.ok(provider.awareness.getStates().has(remoteDoc.clientID));
    assert.equal(frames.length, 0, 'remote state must not consume room ingress budget');
    provider.awareness.setLocalStateField('user', { userId: 'local' });
    assert.equal(frames.length, 1);
    provider.awareness.setLocalState(null);
    assert.equal(frames.length, 2, 'local departures still broadcast');
  } finally {
    provider.destroy();
    doc.destroy();
    remoteDoc.destroy();
  }
});


test('coalesces simultaneous cursor/view input and preserves immediate editing state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const publisher = createMotionPublisher(awareness);
  let updates = 0;
  awareness.on('update', () => updates++);
  try {
    for (let index = 0; index < 100; index++) {
      publisher.set('cursor', { x: index });
      publisher.set('view', { x: index, zoom: 1 });
      t.mock.timers.tick(10);
    }
    assert.equal(updates, 10);
    assert.equal(awareness.getLocalState().cursor.x, 99);
    assert.equal(awareness.getLocalState().view.x, 99);
    publisher.set('cursor', { x: 101 });
    awareness.setLocalStateField('editingItemId', 'card');
    t.mock.timers.tick(100);
    assert.equal(awareness.getLocalState().editingItemId, 'card');
    publisher.set('cursor', { x: 102 });
    publisher.set('view', { x: 102 });
    publisher.set('cursor', null);
    t.mock.timers.tick(100);
    assert.equal(awareness.getLocalState().cursor, null);
    assert.equal(awareness.getLocalState().view.x, 102);
    publisher.set('cursor', { x: 103 });
    publisher.destroy();
    t.mock.timers.tick(100);
    assert.equal(awareness.getLocalState().cursor, null);
  } finally { publisher.destroy(); doc.destroy(); }
});
