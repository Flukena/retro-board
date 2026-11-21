import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresenceBroadcast } from './use-presence-broadcast.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withSsrModule } from '../../test-support/ssr-load.js';
import { createFakeClock } from '../../test-support/fake-clock.js';

function fixture() {
  const clock = createFakeClock(100);
  const sent = [];
  const storage = {
    setLocalCursor(value) { assert.equal(this, storage); sent.push(['cursor', value]); },
    setLocalView(value) { assert.equal(this, storage); sent.push(['view', value]); },
  };
  return { clock, sent, controller: createPresenceBroadcast({ getStorage: () => storage, clock }) };
}

test('broadcast transforms view centers, deduplicates last published view and cancels a stale trailing view', () => {
  const { clock, sent, controller } = fixture();
  const size = { w: 800, h: 600 };
  controller.publishLocalView({ x: 0, y: 0, zoom: 2 }, size);
  assert.deepEqual(sent, [['view', { x: 200, y: 150, zoom: 2 }]]);
  clock.advance(10);
  controller.publishLocalView({ x: 100, y: 100, zoom: 2 }, size);
  controller.publishLocalView({ x: 0.01, y: 0.01, zoom: 2 }, size);
  clock.advance(24);
  assert.equal(sent.length, 1);
  controller.publishLocalView({ x: NaN, y: 0, zoom: 1 }, size);
  assert.equal(sent.length, 1);
});

test('cursor/view schedules are independent 24ms channels and dispose cancels both then clears presence', () => {
  const { clock, sent, controller } = fixture();
  const size = { w: 800, h: 600 };
  controller.publishLocalCursor({ x: 10, y: 20 });
  controller.publishLocalView({ x: 0, y: 0, zoom: 1 }, size);
  controller.publishLocalCursor({ x: 30, y: 40 });
  controller.publishLocalView({ x: 100, y: 0, zoom: 1 }, size);
  assert.equal(clock.pendingCount(), 2);
  clock.advance(24);
  assert.deepEqual(sent.slice(2), [['cursor', { x: 30, y: 40 }], ['view', { x: 300, y: 300, zoom: 1 }]]);
  controller.publishLocalCursor({ x: 50, y: 60 });
  controller.publishLocalView({ x: 200, y: 0, zoom: 1 }, size);
  controller.dispose();
  clock.advance(100);
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(sent.slice(4), [['cursor', null], ['view', null]]);
});

test('broadcast tolerates absent optional storage while disposing pending timers', () => {
  const clock = createFakeClock();
  const controller = createPresenceBroadcast({ getStorage: () => undefined, clock });
  controller.publishLocalCursor({ x: 1, y: 2 });
  controller.publishLocalView({ x: 0, y: 0, zoom: 1 }, { w: 800, h: 600 });
  controller.dispose();
  clock.advance(100);
  assert.equal(clock.pendingCount(), 0);
});

test('broadcast callbacks keep their identities until viewportSize changes', async () => {
  await withSsrModule('/src/client/session/use-presence-broadcast.js', async ({ usePresenceBroadcastState, usePresenceBroadcast }) => {
    const renders = [];
    const size = { w: 800, h: 600 };
    function Probe() {
      const [step, setStep] = React.useState(0);
      const state = usePresenceBroadcastState();
      renders.push(usePresenceBroadcast(state, step < 2 ? size : { w: 900, h: 600 }));
      if (step < 2) setStep(step + 1);
      return null;
    }
    renderToStaticMarkup(React.createElement(Probe));
    assert.equal(renders.length, 3);
    assert.equal(renders[0].publishLocalCursor, renders[2].publishLocalCursor);
    assert.equal(renders[0].clearLocalCursor, renders[2].clearLocalCursor);
    assert.equal(renders[0].publishLocalView, renders[1].publishLocalView);
    assert.notEqual(renders[1].publishLocalView, renders[2].publishLocalView);
  });
});
