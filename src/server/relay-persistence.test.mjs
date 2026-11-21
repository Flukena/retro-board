import test from 'node:test';
import assert from 'node:assert/strict';
import * as config from './relay-config.js';
import { persistenceFixture, deferred, settle, DOC_NAME } from '../test-support/relay-persistence-fixture.js';

const REMEASURE_INTERVAL_MS = 100;

test('compaction subtracts only the captured generation and remeasures on its own cooldown', async t => {
  const flushed = deferred();
  const fixture = await persistenceFixture(t, { flush: () => flushed.promise });
  fixture.doc.getMap('data').set('first', 1);
  fixture.doc.getMap('data').set('second', 2);
  assert.deepEqual(fixture.flushes, [DOC_NAME]);
  fixture.doc.getMap('data').set('concurrent', 3);
  const churn = fixture.state.maintenance.roomPersistenceChurn.get(DOC_NAME);
  const concurrentBytes = fixture.stores[2].bytes + config.STORE_OPERATION_OVERHEAD_BYTES;
  flushed.resolve();
  await churn.compactionPromise;
  assert.equal(churn.uncompactedUpdates, 1);
  assert.equal(churn.uncompactedBytes, concurrentBytes);
  assert.equal(fixture.timers.at(-1).delayMs, REMEASURE_INTERVAL_MS);
  fixture.advance(REMEASURE_INTERVAL_MS);
  fixture.timers.at(-1).callback();
  await churn.compactionPromise;
  assert.deepEqual(fixture.flushes, [DOC_NAME], 'remeasure does not flush before compaction cooldown');
  assert.equal(churn.remeasureRequested, false);
});

test('store failure latches one fatal drain even if more than one queued operation fails', async t => {
  t.mock.method(console, 'error', () => {});
  const fixture = await persistenceFixture(t, { store: async () => { throw new Error('fake disk failure'); } });
  fixture.doc.getMap('data').set('first', 1);
  await settle();
  fixture.doc.getMap('data').set('second', 2);
  await settle();
  assert.deepEqual(fixture.state.shutdowns, [['storage failure', true]]);
});

test('shutdown drain observes queued stores until their completion', async t => {
  const stored = deferred();
  const observations = [];
  const fixture = await persistenceFixture(t, {
    store: () => stored.promise,
    drain: async options => {
      observations.push(options.isBusy());
      stored.resolve(1);
      await settle();
      observations.push(options.isBusy());
    },
  });
  fixture.doc.getMap('data').set('pending', true);
  await fixture.state.lifecycle.drain();
  assert.deepEqual(observations, [true, false]);
});
