import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { scheduleToastDismiss } from './use-toast.js';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const AUTO_DISMISS_MS = 3200;

test('setToast keeps its identity across a real React render-phase update and timestamps replacement messages', async () => {
  await withChromeModule('/src/client/ui/use-toast.js', ({ useToast }) => {
    const renders = [];
    function ToastProbe() {
      const [toast, setToast] = useToast();
      renders.push({ toast, setToast });
      if (toast === null) setToast({ msg: 'Saved', type: 'info', t: -1 });
      return React.createElement('span', null, toast?.msg);
    }
    const beforeMs = Date.now();
    assert.equal(renderToStaticMarkup(React.createElement(ToastProbe)), '<span>Saved</span>');
    const afterMs = Date.now();
    assert.equal(renders.length, 2);
    assert.equal(renders[0].setToast, renders[1].setToast);
    assert.equal(renders[1].toast.msg, 'Saved');
    assert.equal(renders[1].toast.type, 'info');
    assert.ok(renders[1].toast.t >= beforeMs && renders[1].toast.t <= afterMs);
  });
});

test('dismiss scheduling skips absent/sticky messages, clears on disposal, and dismisses to null', async () => {
  await withChromeModule('/src/client/ui/use-toast.js', ({ scheduleToastDismiss }) => {
    const scheduled = [];
    const cancelled = [];
    const values = [];
    const timerId = Symbol('timer');
    const clock = {
      setTimeout: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return timerId; },
      clearTimeout: (id) => cancelled.push(id),
    };
    for (const toast of [null, { msg: 'Pinned', sticky: true }]) {
      assert.equal(scheduleToastDismiss(toast, value => values.push(value), clock), undefined);
    }
    assert.deepEqual(scheduled, []);
    const dispose = scheduleToastDismiss({ msg: 'Saved' }, value => values.push(value), clock);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delayMs, AUTO_DISMISS_MS);
    assert.deepEqual(values, []);
    scheduled[0].callback();
    assert.deepEqual(values, [null]);
    dispose();
    assert.deepEqual(cancelled, [timerId]);
  });
});

for (const enforceScheduleReceiver of [true, false]) {
  const operation = enforceScheduleReceiver ? 'scheduling' : 'cleanup';
  test(`default toast clock preserves the host receiver during ${operation}`, () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timerId = Symbol('host timer');
    const scheduled = [];
    const cancelled = [];
    const dismissed = [];
    try {
      globalThis.setTimeout = function (callback, delayMs) {
        if (enforceScheduleReceiver && this !== globalThis) throw new TypeError('Illegal invocation');
        scheduled.push({ callback, delayMs });
        return timerId;
      };
      globalThis.clearTimeout = function (id) {
        if (this !== globalThis) throw new TypeError('Illegal invocation');
        cancelled.push(id);
      };
      const dispose = scheduleToastDismiss({ msg: 'Saved' }, value => dismissed.push(value));
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].delayMs, AUTO_DISMISS_MS);
      assert.deepEqual(dismissed, []);
      scheduled[0].callback();
      assert.deepEqual(dismissed, [null]);
      dispose();
      assert.deepEqual(cancelled, [timerId]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
}
