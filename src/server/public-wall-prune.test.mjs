import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

const populatedDoc = (rows) => {
  const doc = new Y.Doc();
  for (const [id, createdAt] of rows) doc.getMap('items').set(id, new Y.Map([['createdAt', createdAt]]));
  return doc;
};
test('prune removes oldest timestamps, missing first, with stable ID ties in one transaction', async () => {
  const { prunePublicWall } = await import('./public-wall-prune.js');
  const doc = populatedDoc([['z', 9], ['b', 1], ['a', 1], ['missing', null]]);
  const origins = [];
  doc.on('afterTransaction', tx => origins.push(tx.origin));
  assert.equal(prunePublicWall(doc, 2), 2);
  assert.deepEqual([...doc.getMap('items').keys()], ['z', 'b']);
  assert.deepEqual(origins, ['public-prune']);
  assert.equal(prunePublicWall(doc, 2), 0);
  assert.deepEqual(origins, ['public-prune']);
  doc.destroy();
});
test('default prune cap retains exactly 1500 items and leaves unrelated state intact', async () => {
  const { prunePublicWall } = await import('./public-wall-prune.js');
  const doc = populatedDoc(Array.from({ length: 1502 }, (_, index) => [String(index), index]));
  doc.getMap('meta').set('title', 'keep');
  assert.equal(prunePublicWall(doc), 2);
  assert.equal(doc.getMap('items').size, 1500);
  assert.equal(doc.getMap('items').has('0'), false);
  assert.equal(doc.getMap('meta').get('title'), 'keep');
  doc.destroy();
});

test('malformed CRDT item values cannot prevent the server item cap', async () => {
  const { prunePublicWall } = await import('./public-wall-prune.js');
  const doc = populatedDoc([['valid', 10]]);
  doc.getMap('items').set('malformed', { get: 'not callable' });
  assert.equal(prunePublicWall(doc, 1), 1);
  assert.equal(doc.getMap('items').has('malformed'), false);
  doc.destroy();
});

test('far-future creation times are oldest while bounded positive clock skew remains valid', async () => {
  const { prunePublicWall } = await import('./public-wall-prune.js');
  const { PUBLIC_CREATED_AT_CLOCK_SKEW_MS } = await import('./public-wall-config.js');
  const nowMs = 1700000000000;
  const skewMs = PUBLIC_CREATED_AT_CLOCK_SKEW_MS ?? 60000;
  const doc = populatedDoc([['honest', nowMs - 1], ['future', nowMs + skewMs + 1], ['skew', nowMs + skewMs]]);
  try {
    assert.equal(prunePublicWall(doc, 2, nowMs), 1);
    assert.equal(doc.getMap('items').has('future'), false);
    assert.equal(doc.getMap('items').has('honest'), true);
    assert.equal(doc.getMap('items').has('skew'), true);
  } finally { doc.destroy(); }
});
