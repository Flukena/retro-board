#!/usr/bin/env node
// Isolated Public pan regression. Never seeds a production board.
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_PATH } from '../src/domain/public-wall-contract.js';
import { wheelDeltaForZoomFactor } from '../src/domain/viewport-zoom.js';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const PLAYWRIGHT_MODULE = '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const MAX_P95_FRAME_DURATION_MS = 50;
const FRAME_COUNT = 180;
const PAN_DELTA_PX = 6;
const ZOOM_DELTA_Y_PX = 0.72;
const SETTLE_MS = 600;
const TIMEOUT_MS = 15_000;
const DESKTOP_DEVICE_SCALE_FACTOR = 2;
const MOBILE_DEVICE_SCALE_FACTOR = 3;
const TRACE_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_PAN_PAINT_COUNT = 8;
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const CARD_DETAIL_TEST_ZOOM = 0.12;
const FIXTURE_COLOR_COUNT = 5;
const SMOOTH_P95_FRAME_MS = 18;
const SMOOTH_MAX_FRAME_MS = 50;
const INTERACTION_MARGIN_PX = 160;
const SWEEP_START_ZOOM = 0.12;
const SWEEP_END_ZOOM = 1;
const SWEEP_FRAMES_PER_DIRECTION = 90;
const SWEEP_IDLE_FRAMES = 30;
const SWEEP_ROUND_COUNT = 3;
const MAX_SWEEP_MINIMAP_REDRAWS = SWEEP_ROUND_COUNT * 2 + 1;
const MAX_SLOW_FRAME_SAMPLES = 16;
const FRAME_P95_QUANTILE = 0.95;
const PINCH_START_ZOOM = 0.12;
const PINCH_NEAR_GAP_PX = 40;
const PINCH_FAR_GAP_PX = 160;
const PINCH_STEPS_PER_DIRECTION = 60;
const PINCH_ROUND_COUNT = 3;
const PINCH_INPUT_INTERVAL_MS = 16;
const PINCH_MIN_ZOOM_GAIN = 1.5;
const PINCH_REVERSAL_EPSILON = 1e-4;
// Re-rastering the visible board each frame costs ~51 tiles at 390px/3x;
// held raster stays near 15. Fail well before the per-frame re-raster returns.
const MAX_PINCH_RASTER_TILES_PER_INPUT_FRAME = 25;
const TOUCH_FINGER_IDS = [1, 2];
const RASTER_TRACE_CATEGORIES = 'devtools.timeline,disabled-by-default-devtools.timeline,cc';
const RASTER_TRACE_MODES = ['zoom', 'cards-zoom', 'zoom-sweep', 'pinch'];
const MICROSECONDS_PER_MS = 1000;
const FIXTURE_PROFILES = {
  images: { noteCount: 20, noteColumns: 5, stepXPx: 1100, stepYPx: 900, cpuSlowdown: 1,
    modes: ['fit', 'image', 'zoom'] },
  cards: { noteCount: 1000, noteColumns: 40, stepXPx: 320, stepYPx: 280, cpuSlowdown: 4,
    modes: ['cards', 'cards-zoom'] },
};
const [baseArg, outputArg, engine = 'webkit', profile = 'images'] = process.argv.slice(2);
FIXTURE_PROFILES.smooth = { ...FIXTURE_PROFILES.cards, gpu: true, maxP95Ms: SMOOTH_P95_FRAME_MS, maxFrameMs: SMOOTH_MAX_FRAME_MS };
FIXTURE_PROFILES.sweep = { ...FIXTURE_PROFILES.smooth, gpu: engine === 'chromium', modes: ['zoom-sweep'] };
FIXTURE_PROFILES.pinch = { ...FIXTURE_PROFILES.cards, modes: ['pinch'], mobileOnly: true };
assert.ok(Object.hasOwn(FIXTURE_PROFILES, profile), 'Use images, cards, smooth, sweep or pinch fixture');
assert.ok(profile !== 'pinch' || engine === 'chromium', 'The pinch profile requires Chromium trusted CDP touches');
assert.ok(profile !== 'smooth' || engine === 'chromium', 'The smooth profile requires Chromium hardware GPU');
const fixture = FIXTURE_PROFILES[profile];
assert.ok(baseArg && outputArg, 'Pass an isolated local base URL and SSD output');
const base = new URL(baseArg);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname) && base.port === '5188', 'Use isolated local port 5188');
const output = resolve(outputArg);
assert.ok(output.startsWith(`${SSD_ROOT}/`), 'Output must be on the operator SSD');
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev, 'SSD must be mounted');
assert.ok(['chromium', 'webkit'].includes(engine));
await mkdir(join(output, 'browser-temp'), { recursive: true });
process.env.TMPDIR = join(output, 'browser-temp');
const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || PLAYWRIGHT_MODULE).href);
const browser = await playwright[engine].launch({ headless: true, args: fixture.gpu ? ['--enable-gpu'] : [] });
const report = { engine, profile, noteCount: fixture.noteCount, cpuSlowdown: engine === 'chromium' ? fixture.cpuSlowdown : 1, samples: [], errors: [] };
const fixturePrefix = `pan-${Date.now()}`;
let fixturePage;


async function seedFixture(page) {
  await page.evaluate(async ({ prefix, fixture, colorCount }) => {
    const board = (await window.storage.get('boardState', true)).value;
    if (board.items.length) throw new Error('Pan check requires an empty dedicated Public board');
    const canvas = document.createElement('canvas');
    canvas.width = 675; canvas.height = 1200;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, 'teal'); gradient.addColorStop(1, 'orange');
    context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolveBlob => canvas.toBlob(resolveBlob, 'image/png'));
    const src = await window.storage.uploadImage(blob);
    const items = [
      { id: `${prefix}-zone`, type: 'zone', x: 2960.375, y: 6340.625, w: 12440, h: 4640, title: 'Pan fixture', color: 0 },
      { id: `${prefix}-overlap-zone`, type: 'zone', x: 3300.375, y: 7250.625, w: 1860.5, h: 2880.5, title: 'Image edge fixture', color: 1 },
      { id: `${prefix}-image-a`, type: 'image', x: 4130.125, y: 8080.375, w: 700.5, h: 1230.25, src },
      { id: `${prefix}-image-b`, type: 'image', x: 7000, y: 7500, w: 940, h: 1670, src },
    ];
    for (let index = 0; index < fixture.noteCount; index += 1) items.push({
      id: `${prefix}-note-${index}`, type: 'sticky', text: `Performance note ${index}`, private: false,
      x: 2500 + index % fixture.noteColumns * fixture.stepXPx, y: 5500 + Math.floor(index / fixture.noteColumns) * fixture.stepYPx,
      w: 280, h: 240, color: index % colorCount,
    });
    if (!window.storage.addItems(items, { silent: true })) throw new Error('Pan fixture rejected');
  }, { prefix: fixturePrefix, fixture, colorCount: FIXTURE_COLOR_COUNT });
}

async function participant(viewport) {
  const mobile = viewport.width < VIEWPORTS[0].width;
  const deviceScaleFactor = mobile ? MOBILE_DEVICE_SCALE_FACTOR : DESKTOP_DEVICE_SCALE_FACTOR;
  const context = await browser.newContext({ viewport, deviceScaleFactor, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(() => { localStorage.setItem('rb_lang', 'en'); localStorage.setItem('rb_scroll_wheel_zoom', 'false'); });
  await context.addInitScript(() => {
    window.__rbPanMinimapDraws = 0;
    const setTransform = CanvasRenderingContext2D.prototype.setTransform;
    CanvasRenderingContext2D.prototype.setTransform = function (...args) {
      if (this.canvas.closest?.('.rb-minimap')) window.__rbPanMinimapDraws++;
      return setTransform.apply(this, args);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  if (engine === 'chromium' && fixture.cpuSlowdown > 1) {
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: fixture.cpuSlowdown });
  }
  page.on('pageerror', error => report.errors.push(error.name));
  await page.goto(new URL(PUBLIC_PATH, base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.storage?.synced?.() === true);
  if (await page.locator('#name-dialog-title').count()) await page.keyboard.press('Escape');
  return page;
}

async function frameImage(page, targetZoom = 1) {
  await page.evaluate(() => {
    const surface = document.querySelector('.rb-no-select');
    const rect = surface.querySelector('img').getBoundingClientRect();
    surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
      deltaX: rect.x + rect.width / 2 - innerWidth / 2, deltaY: rect.y + rect.height / 2 - innerHeight / 2 }));
  });
  await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  await zoomAtPoint(page, targetZoom);
}

async function zoomAtPoint(page, targetZoom, point = null) {
  const currentZoom = await page.locator('.rb-no-select').evaluate(surface => new DOMMatrix(getComputedStyle(surface.firstElementChild).transform).a);
  const deltaY = wheelDeltaForZoomFactor(targetZoom / currentZoom, true);
  await page.evaluate(({ deltaY, point }) => {
    document.querySelector('.rb-no-select').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
      deltaY, clientX: point?.x ?? innerWidth / 2, clientY: point?.y ?? innerHeight / 2 }));
  }, { deltaY, point });
}

function frameTimingSummary(intervals) {
  const sorted = intervals.toSorted((first, second) => first - second);
  return { p95Ms: sorted[Math.floor(sorted.length * FRAME_P95_QUANTILE)], maxMs: sorted.at(-1) };
}

async function beginPaintTrace(page, mode) {
  if (engine !== 'chromium' || !['image', 'cards', 'zoom', 'zoom-sweep', 'cards-zoom', 'pinch'].includes(mode)) return null;
  const session = await page.context().newCDPSession(page);
  await session.send('Tracing.start', { categories: RASTER_TRACE_MODES.includes(mode) ? RASTER_TRACE_CATEGORIES : 'devtools.timeline', transferMode: 'ReturnAsStream' });
  return session;
}

async function finishPaintTrace(session, viewport, mode) {
  if (!session) return { paintCount: null };
  const completed = new Promise(resolveTrace => session.once('Tracing.tracingComplete', resolveTrace));
  await session.send('Tracing.end');
  const { stream } = await completed;
  const chunks = [];
  let eof = false;
  while (!eof) {
    const chunk = await session.send('IO.read', { handle: stream, size: TRACE_READ_CHUNK_BYTES });
    chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
    eof = chunk.eof;
  }
  await session.send('IO.close', { handle: stream });
  const bytes = Buffer.concat(chunks);
  await writeFile(join(output, `paint-${viewport.width}-${mode}.json`), bytes);
  const events = JSON.parse(bytes).traceEvents;
  const rasterTasks = events.filter(event => event.name === 'RasterTask');
  return { paintCount: events.filter(event => event.name === 'Paint').length,
    rasterTasks: rasterTasks.length,
    rasterMs: Math.round(rasterTasks.reduce((total, event) => total + (event.dur || 0), 0) / MICROSECONDS_PER_MS) };
}

async function measure(page, viewport, mode) {
  await page.getByTitle('Fit to content', { exact: true }).click();
  await page.waitForTimeout(SETTLE_MS);
  const cardView = mode.startsWith('cards');
  const zooming = mode.endsWith('zoom');
  if (mode !== 'fit') { await frameImage(page, cardView ? CARD_DETAIL_TEST_ZOOM : 1); await page.waitForTimeout(SETTLE_MS); }
  if (cardView) await page.waitForFunction(() => document.querySelectorAll('.rb-card-overview').length > 0);
  const rendered = await page.locator('.rb-no-select').evaluate(surface => ({
    nodes: surface.querySelectorAll('*').length,
    cards: surface.querySelectorAll('.rb-sticky,.rb-card-overview').length,
  }));
  const trace = await beginPaintTrace(page, mode);
  const intervals = await page.evaluate(({ frameCount, deltaPx, zooming }) => new Promise(resolveFrames => {
    const surface = document.querySelector('.rb-no-select');
    let previous; let frameCountSoFar = 0; const timings = [];
    function frame(now) {
      if (previous !== undefined) timings.push(now - previous);
      previous = now;
      surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        ctrlKey: zooming, deltaY: frameCountSoFar < frameCount / 2 ? deltaPx : -deltaPx, clientX: innerWidth / 2, clientY: innerHeight / 2 }));
      if (++frameCountSoFar < frameCount) requestAnimationFrame(frame);
      else resolveFrames(timings);
    }
    requestAnimationFrame(frame);
  }), { frameCount: FRAME_COUNT, deltaPx: zooming ? ZOOM_DELTA_Y_PX : PAN_DELTA_PX, zooming });
  const traceSummary = await finishPaintTrace(trace, viewport, mode);
  const { paintCount } = traceSummary;
  const sample = { viewport, mode, rendered, ...traceSummary, ...frameTimingSummary(intervals) };
  report.samples.push(sample);
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...sample }));
  const frameBudgetMs = fixture.maxP95Ms || MAX_P95_FRAME_DURATION_MS;
  assert.ok(sample.p95Ms <= frameBudgetMs, `Pan p95 ${sample.p95Ms}ms exceeds ${frameBudgetMs}ms`);
  if (fixture.maxFrameMs) assert.ok(sample.maxMs <= fixture.maxFrameMs, `Frame pause ${sample.maxMs}ms exceeds ${fixture.maxFrameMs}ms`);
  if (mode === 'image' && paintCount !== null) assert.ok(paintCount <= MAX_PAN_PAINT_COUNT, `Pan repainted ${paintCount} times; use cached layers`);
  assert.equal(await page.locator('.rb-no-select img').first().evaluate(image => getComputedStyle(image.parentElement).filter !== 'none'), profile === 'images', 'Image shadows follow the fixture density');
}

async function sampleViewportSweep(options) {
  const surface = document.querySelector('.rb-no-select'), timings = [], phases = [], slowFrames = [], callbackTimings = [];
  const initialMinimapDraws = window.__rbPanMinimapDraws;
  let previousFrame = null, previousCallback = performance.now();
  const frame = async (phase, round, target, phaseFrame) => {
    const timestamp = await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
    const now = performance.now();
    if (previousFrame !== null) {
      const durationMs = timestamp - previousFrame; timings.push(durationMs);
      if (durationMs > options.maxFrameMs && slowFrames.length < options.maxSlowSamples) slowFrames.push({
        phase, round, target, phaseFrame, durationMs, nativeCards: surface.querySelectorAll('.rb-sticky').length,
        liveZoom: new DOMMatrix(surface.firstElementChild.style.transform).a,
        minimapRedraws: window.__rbPanMinimapDraws - initialMinimapDraws,
      });
    }
    callbackTimings.push(now - previousCallback);
    previousFrame = timestamp; previousCallback = now;
  };
  const samplePhase = label => phases.push({ label, nodes: surface.querySelectorAll('*').length,
    nativeCards: surface.querySelectorAll('.rb-sticky').length, cards: surface.querySelectorAll('[data-sticky-id]').length,
    zoom: new DOMMatrix(getComputedStyle(surface.firstElementChild).transform).a });
  const direction = async (target, round) => {
    const deltaY = options.deltaY * (target === options.endZoom ? 1 : -1);
    for (let index = 0; index < options.frames; index++) {
      surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY, clientX: innerWidth / 2, clientY: innerHeight / 2 }));
      await frame('gesture', round, target, index);
    }
    samplePhase('gesture');
    for (let index = 0; index < options.idleFrames; index++) await frame('settle', round, target, index);
    samplePhase('settled');
  };
  for (let round = 0; round < options.rounds; round++) {
    await direction(options.endZoom, round);
    await direction(options.startZoom, round);
  }
  return { timings, callbackTimings, slowFrames, phases, minimapRedraws: window.__rbPanMinimapDraws - initialMinimapDraws };
}

async function measureZoomSweep(page, viewport) {
  await page.getByTitle('Fit to content', { exact: true }).click();
  await page.waitForTimeout(SETTLE_MS);
  await frameImage(page, SWEEP_START_ZOOM);
  await page.waitForTimeout(SETTLE_MS);
  const trace = await beginPaintTrace(page, 'zoom-sweep');
  const result = await page.evaluate(sampleViewportSweep, {
    startZoom: SWEEP_START_ZOOM, endZoom: SWEEP_END_ZOOM, frames: SWEEP_FRAMES_PER_DIRECTION,
    idleFrames: SWEEP_IDLE_FRAMES, rounds: SWEEP_ROUND_COUNT,
    deltaY: wheelDeltaForZoomFactor(SWEEP_END_ZOOM / SWEEP_START_ZOOM, true) / SWEEP_FRAMES_PER_DIRECTION,
    maxFrameMs: fixture.maxFrameMs, maxSlowSamples: MAX_SLOW_FRAME_SAMPLES,
  });
  const traceSummary = await finishPaintTrace(trace, viewport, 'zoom-sweep');
  const callback = frameTimingSummary(result.callbackTimings);
  const sample = { viewport, mode: 'zoom-sweep', phases: result.phases, slowFrames: result.slowFrames,
    ...traceSummary, minimapRedraws: result.minimapRedraws, ...frameTimingSummary(result.timings),
    callbackP95Ms: callback.p95Ms, callbackMaxMs: callback.maxMs };
  report.samples.push(sample); console.log(JSON.stringify({ ts: new Date().toISOString(), ...sample }));
  assert.ok(sample.minimapRedraws <= MAX_SWEEP_MINIMAP_REDRAWS, `Minimap repainted ${sample.minimapRedraws} times during viewport-only changes`);
  assert.ok(sample.p95Ms <= fixture.maxP95Ms, `Zoom sweep p95 ${sample.p95Ms}ms exceeds ${fixture.maxP95Ms}ms`);
  assert.ok(sample.maxMs <= fixture.maxFrameMs, `Zoom sweep pause ${sample.maxMs}ms exceeds ${fixture.maxFrameMs}ms`);
  for (const phase of sample.phases) {
    assert.equal(phase.cards, fixture.noteCount, 'Zoom must retain the bounded pool of cheap offscreen cards');
    if (phase.label === 'settled' && phase.zoom > SWEEP_START_ZOOM) assert.ok(phase.nativeCards > 0, 'Settling at detail zoom restores native cards even on a dense board');
  }
}

function samplePinchFrames() {
  const surface = document.querySelector('.rb-no-select'), state = { timings: [], frames: [], stop: false, phase: 'idle' };
  window.__rbPinch = state;
  let previous;
  const tick = now => {
    if (previous !== undefined) state.timings.push(now - previous);
    previous = now;
    state.frames.push({ phase: state.phase, zoom: new DOMMatrix(surface.firstElementChild.style.transform).a });
    if (!state.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// A frame whose zoom moves against the fingers is a stale viewport repaint.
function countPinchReversals(frames) {
  let reversals = 0;
  for (let index = 1; index < frames.length; index++) {
    const { phase, zoom } = frames[index], previous = frames[index - 1];
    if (phase !== previous.phase) continue;
    if (phase === 'spread' && zoom < previous.zoom - PINCH_REVERSAL_EPSILON) reversals++;
    if (phase === 'pinch' && zoom > previous.zoom + PINCH_REVERSAL_EPSILON) reversals++;
  }
  return reversals;
}

async function pinchDirection(page, session, phase, fromGapPx, toGapPx) {
  await page.evaluate(value => { window.__rbPinch.phase = value; }, phase);
  const center = viewportCenter(page);
  for (let step = 1; step <= PINCH_STEPS_PER_DIRECTION; step++) {
    const gapPx = fromGapPx + (toGapPx - fromGapPx) * step / PINCH_STEPS_PER_DIRECTION;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingerPoints(center, gapPx) });
    await new Promise(resolveInput => setTimeout(resolveInput, PINCH_INPUT_INTERVAL_MS));
  }
}

function viewportCenter(page) {
  const { width, height } = page.viewportSize();
  return { x: width / 2, y: height / 2 };
}

function fingerPoints(center, gapPx) {
  return TOUCH_FINGER_IDS.map((id, index) => ({ id, x: center.x + (index ? gapPx : -gapPx) / 2, y: center.y }));
}

async function measurePinch(page, viewport) {
  await page.getByTitle('Fit to content', { exact: true }).click();
  await page.waitForTimeout(SETTLE_MS);
  await frameImage(page, PINCH_START_ZOOM);
  await page.waitForTimeout(SETTLE_MS);
  const session = await page.context().newCDPSession(page);
  const trace = await beginPaintTrace(page, 'pinch');
  await page.evaluate(samplePinchFrames);
  const center = viewportCenter(page);
  for (let round = 0; round < PINCH_ROUND_COUNT; round++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingerPoints(center, PINCH_NEAR_GAP_PX) });
    await pinchDirection(page, session, 'spread', PINCH_NEAR_GAP_PX, PINCH_FAR_GAP_PX);
    await pinchDirection(page, session, 'pinch', PINCH_FAR_GAP_PX, PINCH_NEAR_GAP_PX);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.evaluate(() => { window.__rbPinch.phase = 'idle'; });
    await page.waitForTimeout(SETTLE_MS);
  }
  const result = await page.evaluate(() => { window.__rbPinch.stop = true; return window.__rbPinch; });
  const traceSummary = await finishPaintTrace(trace, viewport, 'pinch');
  const peakZoom = Math.max(...result.frames.map(frame => frame.zoom));
  const sample = { viewport, mode: 'pinch', ...traceSummary, peakZoom, reversals: countPinchReversals(result.frames),
    frames: result.timings.length, ...frameTimingSummary(result.timings) };
  report.samples.push(sample);
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...sample }));
  assert.ok(peakZoom >= PINCH_START_ZOOM * PINCH_MIN_ZOOM_GAIN, `Pinch reached only ${peakZoom}x`);
  assert.equal(sample.reversals, 0, 'Pinch frames must never move against the fingers');
  const maxRasterTasks = PINCH_ROUND_COUNT * PINCH_STEPS_PER_DIRECTION * 2 * MAX_PINCH_RASTER_TILES_PER_INPUT_FRAME;
  assert.ok(sample.rasterTasks <= maxRasterTasks, `Pinch rasterized ${sample.rasterTasks} tiles; hold raster during live input`);
  assert.ok(sample.p95Ms <= MAX_P95_FRAME_DURATION_MS, `Pinch p95 ${sample.p95Ms}ms exceeds ${MAX_P95_FRAME_DURATION_MS}ms`);
}

async function checkRasterInteraction(page) {
  const target = await page.locator('.rb-no-select').evaluate((surface, margin) => {
    for (const card of surface.querySelectorAll('[data-sticky-id]')) {
      const rect = card.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (x > margin && y > margin && x < innerWidth - margin && y < innerHeight - margin
        && card.contains(document.elementFromPoint(x, y))) return { id: card.dataset.stickyId, x, y };
    }
    return null;
  }, INTERACTION_MARGIN_PX);
  assert.ok(target, 'A visible overview card must remain pointer accessible');
  assert.ok(await page.locator('.rb-card-overview__text--rasterized').count(), 'The fixture must exercise the bitmap path');
  const originalText = await page.evaluate(async id => (await window.storage.get('boardState', true)).value.items.find(item => item.id === id).text, target.id);
  await page.mouse.move(target.x, target.y);
  const card = page.locator('.rb-sticky').filter({ hasText: originalText }).first();
  await card.waitFor();
  await zoomAtPoint(page, 1, target);
  await page.waitForTimeout(SETTLE_MS);
  await card.dblclick();
  const input = page.getByPlaceholder('Double-click to edit', { exact: true });
  await input.fill(`${originalText} edited`);
  assert.equal(await page.locator('.rb-overview-atlas').count(), 0, 'Editing must use the native editor path');
  await input.press('Escape');
  const expectText = text => page.waitForFunction(async ({ id, text }) =>
    (await window.storage.get('boardState', true)).value.items.find(item => item.id === id).text === text, { id: target.id, text });
  await expectText(`${originalText} edited`);
  await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
  await expectText(originalText);
  await page.getByTitle('Redo (Ctrl+Shift+Z)', { exact: true }).click();
  await expectText(`${originalText} edited`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await page.locator('.rb-sticky--selected').waitFor({ state: 'hidden' });
  await page.mouse.move(1, 1);
  await zoomAtPoint(page, CARD_DETAIL_TEST_ZOOM, target);
  await page.waitForFunction(() => document.querySelectorAll('.rb-card-overview__text--rasterized').length > 0);
  assert.ok(await page.locator('.rb-card-overview__text--rasterized').count(), 'Overview rendering must recover after editing');
  report.interaction = 'overview hover/zoom/edit/undo/redo/recovery passed';
}

try {
  if (fixture.gpu) {
    const session = await browser.newBrowserCDPSession();
    const gpu = (await session.send('SystemInfo.getInfo')).gpu;
    report.gpu = { devices: gpu.devices, features: gpu.featureStatus };
    assert.equal(gpu.featureStatus.gpu_compositing, 'enabled', 'A hardware GPU is required for smooth measurements');
    await session.detach();
  }
  for (const viewport of fixture.mobileOnly ? VIEWPORTS.slice(1) : VIEWPORTS) {
    const page = await participant(viewport);
    if (!fixturePage) { fixturePage = page; await seedFixture(page); }
    await page.getByTitle('Fit to content', { exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.rb-no-select img')].some(image => image.complete && image.naturalWidth));
    for (const mode of fixture.modes) {
      if (mode === 'zoom-sweep') await measureZoomSweep(page, viewport);
      else if (mode === 'pinch') await measurePinch(page, viewport);
      else await measure(page, viewport, mode);
    }
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(output, `public-${viewport.width}.png`) });
    if (fixture.gpu && viewport.width === VIEWPORTS[0].width) await checkRasterInteraction(page);
  }
  assert.deepEqual(report.errors, []);
} finally {
  try {
    if (fixturePage) await fixturePage.evaluate(async prefix => {
      const board = (await window.storage.get('boardState', true)).value;
      window.storage.replaceBoard({ ...board, items: board.items.filter(item => !item.id.startsWith(prefix)) }, { silent: true });
    }, fixturePrefix);
    if (fixturePage) await fixturePage.waitForTimeout(SETTLE_MS);
  } finally {
    try { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
    finally { await browser.close(); }
  }
}
