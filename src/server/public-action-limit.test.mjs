import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PublicActionLimit } from './public-action-limit.js';

const Y = createRequire(import.meta.url)('yjs');
const WINDOW_MS = 60_000;
const START_MS = 1_000_000;

function fixture(t) {
  const doc = new Y.Doc();
  const sender = new Y.Doc();
  const policy = new PublicActionLimit(Y, doc);
  t.after(() => { policy.destroy(); doc.destroy(); sender.destroy(); });
  const change = (ip, edit, now = START_MS) => {
    const vector = Y.encodeStateVector(sender);
    sender.transact(() => edit(sender.getMap('items')));
    const update = Y.encodeStateAsUpdate(sender, vector);
    const accepted = policy.admit(ip, update, now);
    if (accepted) Y.applyUpdate(doc, update);
    return accepted;
  };
  return { doc, sender, policy, change };
}

const add = (map, id, type = 'sticky') => map.set(id, new Y.Map([['type', type]]));

test('public creation is limited to ten items per IP per rolling minute, including bulk operations', t => {
  const { doc, sender, policy, change } = fixture(t);
  assert.equal(change('ip-a', items => { for (let i = 0; i < 10; i += 1) add(items, `a${i}`); }), true);
  assert.equal(change('ip-a', items => add(items, 'blocked')), false);
  assert.equal(doc.getMap('items').has('blocked'), false);
  const pending = Y.encodeStateAsUpdate(sender, Y.encodeStateVector(doc));
  assert.equal(policy.admit('ip-a', pending, START_MS + WINDOW_MS), true);
  Y.applyUpdate(doc, pending);
  assert.equal(doc.getMap('items').has('blocked'), true);
});

test('deletions and edits do not consume the creation quota', t => {
  const { doc, change } = fixture(t);
  assert.equal(change('a', items => { for (let i = 0; i < 10; i += 1) add(items, `a${i}`); }), true);
  assert.equal(change('a', items => { for (let i = 0; i < 9; i += 1) items.delete(`a${i}`); }), true);
  assert.equal(change('a', items => items.get('a9').set('text', 'edited')), true);
  assert.equal(doc.getMap('items').size, 1);
  assert.equal(doc.getMap('items').get('a9').get('text'), 'edited');
});

test('other IPs have independent creation quotas', t => {
  const { doc, sender, change } = fixture(t);
  assert.equal(change('a', items => { for (let i = 0; i < 10; i += 1) add(items, `a${i}`); }), true);
  assert.equal(change('b', items => add(items, 'other')), true);
  assert.equal(doc.getMap('items').size, 11);
  assert.equal(sender.getMap('items').size, 11);
});

test('bulk operations over the limit never mutate the authoritative document', t => {
  const { doc, change } = fixture(t);
  assert.equal(change('a', items => { for (let i = 0; i < 11; i += 1) add(items, `a${i}`); }), false);
  assert.equal(doc.getMap('items').size, 0);
});

test('only one image can be created per minute per IP, and images also count toward creation quota', t => {
  const { doc, sender, policy, change } = fixture(t);
  assert.equal(change('a', items => add(items, 'image1', 'image')), true);
  assert.equal(change('a', items => add(items, 'image2', 'image')), false);
  assert.equal(doc.getMap('items').has('image2'), false);
  const pending = Y.encodeStateAsUpdate(sender, Y.encodeStateVector(doc));
  assert.equal(policy.admit('a', pending, START_MS + WINDOW_MS), true);
  Y.applyUpdate(doc, pending);
  assert.equal(doc.getMap('items').has('image2'), true);
});

test('unresolved updates are rejected instead of bypassing policy when dependencies arrive', t => {
  const { doc, policy } = fixture(t);
  const source = new Y.Doc(); t.after(() => source.destroy());
  add(source.getMap('items'), 'first');
  const vector = Y.encodeStateVector(source);
  add(source.getMap('items'), 'second');
  const missingDependency = Y.encodeStateAsUpdate(source, vector);
  assert.equal(policy.admit('a', missingDependency, START_MS), false);
  assert.equal(doc.getMap('items').size, 0);
});

test('incomplete item creation and later type changes cannot evade image limits', t => {
  const { doc, change } = fixture(t);
  assert.equal(change('a', items => add(items, 'normal')), true);
  assert.equal(change('a', items => items.get('normal').set('type', 'image')), false);
  assert.equal(doc.getMap('items').get('normal').get('type'), 'sticky');
  const other = new Y.Doc(); t.after(() => other.destroy());
  other.getMap('items').set('missing-type', new Y.Map());
  const { policy } = fixture(t);
  assert.equal(policy.admit('a', Y.encodeStateAsUpdate(other), START_MS), false);
});

test('quota updates reach connections sharing an IP and acknowledge the sender creations', async t => {
  const { EventEmitter } = await import('node:events');
  const { registerPublicQuotaClient, admitPublicAction, notifyPublicQuota } = await import('./public-action-limit.js');
  const require = createRequire(import.meta.url);
  const encoding = require('lib0/encoding');
  const decoding = require('lib0/decoding');
  const doc = new Y.Doc();
  const source = new Y.Doc();
  t.after(() => { doc.destroy(); source.destroy(); });
  class Socket extends EventEmitter {
    messages = [];
    readyState = 1;
    send(bytes) {
      const decoder = decoding.createDecoder(bytes);
      assert.equal(decoding.readVarUint(decoder), 4);
      this.messages.push(JSON.parse(decoding.readVarString(decoder)));
    }
  }
  const first = new Socket(), second = new Socket(), other = new Socket();
  registerPublicQuotaClient(Y, doc, 'same-ip', first);
  registerPublicQuotaClient(Y, doc, 'same-ip', second);
  registerPublicQuotaClient(Y, doc, 'other-ip', other);
  source.getMap('items').set('created', new Y.Map([['type', 'sticky']]));
  const update = Y.encodeStateAsUpdate(source);
  const frame = encoding.createEncoder();
  encoding.writeVarUint(frame, 0); encoding.writeVarUint(frame, 2); encoding.writeVarUint8Array(frame, update);
  assert.equal(admitPublicAction(Y, doc, 'same-ip', encoding.toUint8Array(frame), second), true);
  Y.applyUpdate(doc, update);
  notifyPublicQuota(doc, 'same-ip', second);
  assert.equal(first.messages.length, 2);
  assert.equal(second.messages.length, 2);
  assert.equal(other.messages.length, 1);
  assert.equal(first.messages.at(-1).entries[0].creations, 1);
  assert.deepEqual(first.messages.at(-1).acceptedIds, []);
  assert.deepEqual(second.messages.at(-1).acceptedIds, ['created']);
});

test('Public creation rejects unsafe item identifiers before quota notifications', t => {
  const { doc, change } = fixture(t);
  assert.equal(change('a', items => add(items, 'x'.repeat(129))), false);
  assert.equal(doc.getMap('items').size, 0);
});
