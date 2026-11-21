import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinimapVisibility } from './use-minimap.js';
import { createMinimapNavigation } from './use-minimap.js';
import { createFakeClock } from '../../test-support/fake-clock.js';
import { MINIMAP_IDLE_MS } from './minimap-timing.js';
import { buildMinimapModel } from '../../domain/minimap.js';

function timerHarness() {
  const clock = createFakeClock(); let hovered = false; let focused = false;
  const panel = { style: {}, contains: () => focused, matches: () => hovered };
  const options = { minimapPanelRef: { current: panel }, minimapHideTimerRef: { current: null }, interactionRef: { current: null },
    ownerDocument: { activeElement: {} }, clock };
  return { clock, panel, options, controller: createMinimapVisibility(options), hover: value => { hovered = value; }, focus: value => { focused = value; } };
}

test('minimap hide reschedules during hover/focus/navigation, then hides when idle', () => {
  const h = timerHarness(); h.controller.reveal(); assert.equal(h.panel.style.opacity, '1');
  h.hover(true); h.clock.advance(MINIMAP_IDLE_MS); assert.equal(h.panel.style.opacity, '1');
  h.hover(false); h.focus(true); h.clock.advance(MINIMAP_IDLE_MS); assert.equal(h.panel.style.pointerEvents, 'auto');
  h.focus(false); h.options.interactionRef.current = { kind: 'minimap' }; h.clock.advance(MINIMAP_IDLE_MS);
  assert.equal(h.panel.style.opacity, '1'); h.options.interactionRef.current = null; h.clock.advance(MINIMAP_IDLE_MS);
  assert.equal(h.panel.style.opacity, '0'); assert.equal(h.panel.style.pointerEvents, 'none'); assert.equal(h.clock.pendingCount(), 0);
});

test('reveal replaces its timer, dispose cancels it, and absent panels are inert', () => {
  const h = timerHarness(); h.controller.reveal(); h.controller.reveal(); assert.equal(h.clock.pendingCount(), 1);
  h.controller.dispose(); h.clock.advance(MINIMAP_IDLE_MS); assert.equal(h.panel.style.opacity, '1'); assert.equal(h.clock.pendingCount(), 0);
  h.options.minimapPanelRef.current = null; h.controller.reveal(); assert.equal(h.clock.pendingCount(), 0);
});

function navigationHarness() {
  const clock = createFakeClock(); const listeners = new Map(); const commits = []; const order = [];
  let current = { x: 20, y: 30, zoom: 2 };
  const view = { addEventListener(name, callback) { assert.equal(this, view); listeners.set(name, callback); },
    removeEventListener(name, callback) { assert.equal(this, view); assert.equal(listeners.get(name), callback); listeners.delete(name); } };
  const surface = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 120 }) };
  const model = buildMinimapModel({ items: [], viewport: current, viewportSize: { w: 1000, h: 600 }, width: 200, height: 120 });
  const options = { viewport: { getViewport: () => current, commitViewport: next => { current = next; commits.push([next, undefined]); }, previewViewport: next => { current = next; commits.push([next, { live: true }]); }, finishViewport: next => { current = next; commits.push([next, { finish: true }]); } },
    minimapModelRef: { current: model }, interactionRef: { current: null }, activeViewportFinalizerRef: { current: null },
    stopFollowing: () => order.push('stop'), settleWheelBeforeInteraction: () => order.push('settle'), view: view,
    clock: { ...clock, requestAnimationFrame: run => clock.setTimeout(run, 16), cancelAnimationFrame: clock.clearTimeout } };
  const event = (overrides = {}) => ({ button: 0, pointerId: 7, currentTarget: surface, clientX: 100, clientY: 60,
    preventDefault: () => order.push('prevent'), stopPropagation: () => order.push('stopPropagation'), ...overrides });
  return { controller: createMinimapNavigation(options), options, clock, listeners, commits, order, surface, event, current: () => current };
}

test('pointer navigation coalesces latest point, keeps zoom and flushes on matching release', () => {
  const h = navigationHarness(); h.controller.start(h.event());
  assert.deepEqual(h.order, ['stop', 'prevent', 'stopPropagation', 'settle']);
  assert.deepEqual(h.commits[0][1], { live: true }, 'pointer input uses the preview port');
  assert.equal(h.options.interactionRef.current.kind, 'minimap'); assert.equal(h.surface.style.cursor, 'grabbing');
  h.listeners.get('pointermove')(h.event({ clientX: 130 })); h.listeners.get('pointermove')(h.event({ clientX: 140 }));
  assert.equal(h.commits.length, 1); assert.equal(h.clock.pendingCount(), 1);
  h.listeners.get('pointerup')(h.event({ pointerId: 8 })); assert.equal(h.listeners.size, 4);
  h.listeners.get('pointerup')(h.event());
  // Captured from the unmoved pointer callback before extraction.
  assert.deepEqual(h.commits[1][0], { x: -333.8461538461538, y: 30, zoom: 2 });
  assert.equal(h.commits.length, 3); assert.equal(h.commits[1][0].zoom, 2);
  assert.deepEqual(h.commits[1][1], { live: true }, 'queued motion still uses the preview port');
  assert.deepEqual(h.commits[2], [h.current(), { finish: true }]);
  assert.equal(h.listeners.size, 0); assert.equal(h.clock.pendingCount(), 0); assert.equal(h.options.interactionRef.current, null);
  assert.equal(h.options.activeViewportFinalizerRef.current, null); assert.equal(h.surface.style.cursor, 'crosshair');
});

test('cancel/blur/unmount finish navigation and remove pending frames/listeners', () => {
  for (const exit of ['pointercancel', 'blur', 'unmount']) {
    const h = navigationHarness(); h.controller.start(h.event()); h.listeners.get('pointermove')(h.event({ clientX: 140 }));
    if (exit === 'unmount') h.options.activeViewportFinalizerRef.current(); else h.listeners.get(exit)(h.event());
    h.clock.advance(16); assert.equal(h.listeners.size, 0); assert.equal(h.clock.pendingCount(), 0); assert.equal(h.commits.length, 3);
  }
});

test('arrow keys move by 20 percent of viewport size and respect interaction guards', () => {
  const h = navigationHarness(); h.controller.keyDown(h.event({ key: 'ArrowRight' }));
  assert.deepEqual(h.current(), { x: -180, y: 30, zoom: 2 });
  h.controller.keyDown(h.event({ key: 'ArrowUp' })); assert.deepEqual(h.current(), { x: -180, y: 150, zoom: 2 });
  const count = h.commits.length; h.controller.keyDown(h.event({ key: 'Enter' }));
  h.options.interactionRef.current = { kind: 'pan' }; h.controller.keyDown(h.event({ key: 'ArrowDown' })); h.controller.start(h.event());
  assert.equal(h.commits.length, count);
});

test('default minimap timers and animation frames preserve native host receivers', () => {
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const calls = [];
  try {
    globalThis.setTimeout = function (run, delayMs) { assert.equal(this, globalThis); assert.equal(typeof run, 'function'); calls.push(['timer', delayMs]); return 41; };
    globalThis.clearTimeout = function (id) { assert.equal(this, globalThis); calls.push(['clear', id]); };
    globalThis.requestAnimationFrame = function (run) { assert.equal(this, globalThis); assert.equal(typeof run, 'function'); calls.push(['frame']); return 42; };
    globalThis.cancelAnimationFrame = function (id) { assert.equal(this, globalThis); calls.push(['cancelFrame', id]); };
    const h = timerHarness(); const visibility = createMinimapVisibility({ ...h.options, clock: undefined });
    visibility.reveal(); visibility.dispose();
    const nav = navigationHarness(); const navigation = createMinimapNavigation({ ...nav.options, clock: undefined });
    navigation.start(nav.event()); nav.listeners.get('pointermove')(nav.event({ clientX: 140 })); nav.options.activeViewportFinalizerRef.current();
    assert.deepEqual(calls, [['timer', MINIMAP_IDLE_MS], ['clear', 41], ['frame'], ['cancelFrame', 42]]);
  } finally {
    Object.assign(globalThis, saved);
  }
});
