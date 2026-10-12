import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { schedulePresence, usePresence, ZONE_TOOLS_EXIT_DURATION_MS } from './usePresence.js';

function scheduler() {
  const jobs = new Map();
  let nextId = 0;
  return {
    frame(callback) { const id = ++nextId; jobs.set(id, { callback, delay: 0 }); return id; },
    timeout(callback, delay) { const id = ++nextId; jobs.set(id, { callback, delay }); return id; },
    cancel(id) { jobs.delete(id); },
    run(delay) { const job = [...jobs].find(([, value]) => value.delay === delay); assert.ok(job); jobs.delete(job[0]); job[1].callback(); },
    get count() { return jobs.size; },
  };
}

test('presence paints enter before open, retains exit until its duration, and cancels stale work', () => {
  const clock = scheduler();
  const states = [];
  const notify = (state) => states.push(state);
  const cancelEnter = schedulePresence(true, false, notify, clock);
  assert.deepEqual(states, ['enter']);
  clock.run(0);
  assert.deepEqual(states, ['enter']);
  clock.run(0);
  assert.deepEqual(states, ['enter', 'open']);
  cancelEnter();
  const cancelExit = schedulePresence(false, false, notify, clock);
  assert.equal(states.at(-1), 'exit');
  assert.equal(clock.count, 1);
  cancelExit();
  assert.equal(clock.count, 0);
  schedulePresence(false, false, notify, clock);
  clock.run(ZONE_TOOLS_EXIT_DURATION_MS);
  assert.equal(states.at(-1), null);
});

test('reduced motion opens and unmounts immediately without scheduling', () => {
  const clock = scheduler();
  const states = [];
  schedulePresence(true, true, (state) => states.push(state), clock)();
  schedulePresence(false, true, (state) => states.push(state), clock)();
  assert.deepEqual(states, ['open', null]);
  assert.equal(clock.count, 0);
});


test('hook starts unmounted when closed and mounts immediately in reduced motion', () => {
  const original = globalThis.matchMedia;
  let reduced = false;
  globalThis.matchMedia = () => ({ matches: reduced });
  function Inspect({ open }) {
    const presence = usePresence(open);
    return React.createElement('output', { 'data-mounted': presence.mounted, 'data-state': presence.state });
  }
  try {
    assert.match(renderToStaticMarkup(React.createElement(Inspect, { open: false })), /data-mounted="false"/);
    assert.match(renderToStaticMarkup(React.createElement(Inspect, { open: true })), /data-state="enter"/);
    reduced = true;
    assert.match(renderToStaticMarkup(React.createElement(Inspect, { open: true })), /data-state="open"/);
    assert.match(renderToStaticMarkup(React.createElement(Inspect, { open: false })), /data-mounted="false"/);
  } finally {
    if (original === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = original;
  }
});
