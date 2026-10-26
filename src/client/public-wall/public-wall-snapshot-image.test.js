import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { SnapshotImageCapture, embedSnapshotFonts, loadSnapshotFontCSS, PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX,
  PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX, PUBLIC_DOM_RASTER_MAX_ITEMS, SNAPSHOT_RENDERER, snapshotRenderer } from './public-wall-snapshot-image.js';

const FONT_CSS = '@font-face{font-family:Sarabun;src:url(data:font/woff2;base64,Zm9udA==)}';
const FONT_CSS_URL = 'https://retroroom.party/fonts/board-snapshot/fonts.css';
const EXPECTED_RENDER_TIMEOUT_MS = 15_000;
const makeBlob = label => new Blob([label], { type: 'image/png' });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const IMAGE_RESOURCES_FAKE = Object.freeze({ async prepare(node) { return { node, dispose() {} }; }, dispose() {} });

function captureFixture(toBlob, loadFontCSS = async () => FONT_CSS, { toCanvasBlob, imageResources = IMAGE_RESOURCES_FAKE } = {}) {
  const created = [];
  const revoked = [];
  const capture = new SnapshotImageCapture({
    toBlob, loadFontCSS, toCanvasBlob, imageResources,
    urlApi: {
      createObjectURL(blob) { created.push(blob); return `blob:snapshot-${created.length}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
  });
  return { capture, created, revoked };
}

test('snapshot capture uses the actual scene with fixed bounded PNG dimensions and embedded fonts', async () => {
  const scene = { label: 'actual React board DOM' };
  const calls = [];
  const fixture = captureFixture(async (...args) => { calls.push(args); return makeBlob('real scene'); });
  try {
    await fixture.capture.capture(scene, 'revision-a');
    await fixture.capture.capture(scene, 'revision-a');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], scene);
    assert.equal(calls[0][1].width, PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX);
    assert.equal(calls[0][1].height, PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX);
    assert.equal(calls[0][1].pixelRatio, 1);
    assert.equal(calls[0][1].fontEmbedCSS, FONT_CSS);
    assert.equal(calls[0][1].cacheBust, false);
    assert.equal(calls[0][1].style.transform, 'none');
    assert.equal(calls[0][1].style.insetBlock, '0px auto');
    assert.equal(calls[0][1].style.insetInline, '0px auto');
    assert.deepEqual(fixture.capture.state, { imageUrl: 'blob:snapshot-1', status: 'ready' });
  } finally { fixture.capture.dispose(); }
});

test('converter failures leave the DOM fallback available instead of silently omitting uploaded images', async () => {
  const fixture = captureFixture(async (scene, options) => {
    assert.deepEqual(options.fetchRequestInit, { credentials: 'omit', redirect: 'error' });
    assert.equal(options.onImageErrorHandler, undefined);
    throw new Error('Image conversion failed');
  });
  try {
    await fixture.capture.capture({}, 'missing image');
    assert.deepEqual(fixture.capture.state, { imageUrl: null, status: 'unavailable' });
  } finally { fixture.capture.dispose(); }
});

test('capture coalesces pending revisions and never publishes an obsolete PNG', async () => {
  const started = deferred();
  const first = deferred();
  const scenes = [];
  let active = 0;
  let peakActive = 0;
  const fixture = captureFixture(async scene => {
    scenes.push(scene);
    active += 1;
    peakActive = Math.max(peakActive, active);
    if (scenes.length === 1) { started.resolve(); await first.promise; }
    active -= 1;
    return makeBlob(scene.label);
  });
  try {
    const completed = fixture.capture.capture({ label: 'old' }, 'old');
    await started.promise;
    fixture.capture.capture({ label: 'superseded' }, 'middle');
    fixture.capture.capture({ label: 'latest' }, 'latest');
    first.resolve();
    await completed;
    assert.deepEqual(scenes.map(scene => scene.label), ['old', 'latest']);
    assert.equal(peakActive, 1);
    assert.equal(fixture.created.length, 1);
    assert.equal(await fixture.created[0].text(), 'latest');
  } finally { fixture.capture.dispose(); }
});

test('failed capture keeps the last PNG and successful replacement and disposal release their URLs', async () => {
  const fixture = captureFixture(async scene => {
    if (scene.fail) throw new Error('Rasterization failed');
    return makeBlob('real scene');
  });
  await fixture.capture.capture({}, 'first');
  await fixture.capture.capture({ fail: true }, 'failed');
  assert.deepEqual(fixture.capture.state, { imageUrl: 'blob:snapshot-1', status: 'unavailable' });
  assert.deepEqual(fixture.revoked, []);
  await fixture.capture.capture({}, 'failed');
  assert.deepEqual(fixture.revoked, ['blob:snapshot-1']);
  fixture.capture.dispose();
  assert.deepEqual(fixture.revoked, ['blob:snapshot-1', 'blob:snapshot-2']);
  fixture.capture.dispose();
  assert.equal(fixture.revoked.length, 2);
});

test('a failed font load retries the same revision and deduplicates again after capture succeeds', async () => {
  let fontCalls = 0;
  let rasterCalls = 0;
  const fixture = captureFixture(async () => { rasterCalls += 1; return makeBlob('ready'); }, async () => {
    fontCalls += 1;
    if (fontCalls === 1) throw new Error('Font download failed');
    return FONT_CSS;
  });
  try {
    await fixture.capture.capture({}, 'same revision');
    assert.deepEqual(fixture.capture.state, { imageUrl: null, status: 'unavailable' });
    await fixture.capture.capture({}, 'same revision');
    assert.deepEqual(fixture.capture.state, { imageUrl: 'blob:snapshot-1', status: 'ready' });
    await fixture.capture.capture({}, 'same revision');
    assert.equal(fontCalls, 2);
    assert.equal(rasterCalls, 1);
  } finally { fixture.capture.dispose(); }
});

test('stalled rasterization times out, preserves the prior PNG and recovers on retry without publishing a late result', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred();
  const stalled = deferred();
  const fixture = captureFixture(async scene => {
    if (scene.stall) { started.resolve(); return stalled.promise; }
    return makeBlob('ready');
  });
  try {
    await fixture.capture.capture({}, 'prior');
    const timedOut = fixture.capture.capture({ stall: true }, 'next');
    await started.promise;
    context.mock.timers.tick(EXPECTED_RENDER_TIMEOUT_MS);
    await nextEventLoopTurn();
    assert.deepEqual(fixture.capture.state, { imageUrl: 'blob:snapshot-1', status: 'unavailable' });
    assert.deepEqual(fixture.revoked, []);
    await timedOut;
    await fixture.capture.capture({}, 'next');
    assert.deepEqual(fixture.capture.state, { imageUrl: 'blob:snapshot-2', status: 'ready' });
    stalled.resolve(makeBlob('obsolete late output'));
    await nextEventLoopTurn();
    assert.equal(fixture.created.length, 2);
    assert.deepEqual(fixture.capture.state, { imageUrl: 'blob:snapshot-2', status: 'ready' });
  } finally { fixture.capture.dispose(); }
});

test('disposing an in-flight capture never allocates or publishes a late Blob URL', async () => {
  const started = deferred();
  const result = deferred();
  const fixture = captureFixture(async () => { started.resolve(); return result.promise; });
  const completed = fixture.capture.capture({}, 'first');
  await started.promise;
  fixture.capture.dispose();
  result.resolve(makeBlob('late'));
  await completed;
  assert.deepEqual(fixture.created, []);
});

test('successful capture and disposal both clear their render deadline timers', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const cleared = context.mock.method(globalThis, 'clearTimeout');
  const started = deferred();
  const fixture = captureFixture(async scene => {
    if (scene.stall) { started.resolve(); return new Promise(() => {}); }
    return makeBlob('ready');
  });
  try {
    await fixture.capture.capture({}, 'ready');
    assert.equal(cleared.mock.callCount(), 1);
    let completed = false;
    const completion = fixture.capture.capture({ stall: true }, 'disposed').then(() => { completed = true; });
    await started.promise;
    fixture.capture.dispose();
    await nextEventLoopTurn();
    assert.equal(completed, true);
    await completion;
    assert.equal(cleared.mock.callCount(), 2);
    assert.deepEqual(fixture.revoked, ['blob:snapshot-1']);
    assert.equal(fixture.created.length, 1);
  } finally { fixture.capture.dispose(); }
});

test('font embedding fetches each same-origin font once and replaces every CSS font URL', async () => {
  const fetched = [];
  const css = '@font-face{font-family:Sarabun;src:url("./thai.woff2")}\n@font-face{font-family:Sarabun;src:url(./thai.woff2)}';
  const result = await embedSnapshotFonts(css, FONT_CSS_URL, async (url, options) => {
    fetched.push({ url, options });
    return new Response(new Blob(['font'], { type: 'font/woff2' }));
  });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, 'https://retroroom.party/fonts/board-snapshot/thai.woff2');
  assert.equal(fetched[0].options.credentials, 'omit');
  assert.equal((result.match(/data:font\/woff2;base64,Zm9udA==/g) ?? []).length, 2);
  assert.doesNotMatch(result, /\.\/thai\.woff2/);
});

test('font embedding rejects third-party font fetches instead of changing CSP or dropping fonts', async () => {
  let calls = 0;
  await assert.rejects(embedSnapshotFonts('@font-face{src:url(https://fonts.gstatic.com/external.woff2)}',
    FONT_CSS_URL, async () => { calls += 1; return new Response(); }), /same origin/);
  assert.equal(calls, 0);
});

test('empty raster output reports unavailable without allocating an image URL', async () => {
  const fixture = captureFixture(async () => null);
  try {
    await fixture.capture.capture({}, 'empty');
    assert.deepEqual(fixture.capture.state, { imageUrl: null, status: 'unavailable' });
    assert.deepEqual(fixture.created, []);
  } finally { fixture.capture.dispose(); }
});

test('font stylesheet embedding is shared and cached after success and retries a failed download', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://retroroom.party' } } });
  let fail = true;
  const fetched = [];
  globalThis.fetch = async url => {
    fetched.push(url);
    if (fail) return new Response(null, { status: 503 });
    return url.endsWith('.css')
      ? new Response('@font-face{src:url(./thai.woff2)}')
      : new Response(new Blob(['font'], { type: 'font/woff2' }));
  };
  try {
    await assert.rejects(loadSnapshotFontCSS(), /unavailable/);
    fail = false;
    const first = loadSnapshotFontCSS();
    assert.equal(loadSnapshotFontCSS(), first);
    assert.match(await first, /data:font\/woff2;base64,Zm9udA==/);
    assert.equal(loadSnapshotFontCSS(), first);
    assert.deepEqual(fetched, [FONT_CSS_URL, FONT_CSS_URL,
      'https://retroroom.party/fonts/board-snapshot/thai.woff2']);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
});

const sceneWithItems = count => ({ dataset: { itemCount: String(count) } });

test('boards above the DOM raster limit are painted on canvas instead of converting every card', () => {
  assert.equal(snapshotRenderer(0), SNAPSHOT_RENDERER.DOM);
  assert.equal(snapshotRenderer(PUBLIC_DOM_RASTER_MAX_ITEMS), SNAPSHOT_RENDERER.DOM);
  assert.equal(snapshotRenderer(PUBLIC_DOM_RASTER_MAX_ITEMS + 1), SNAPSHOT_RENDERER.CANVAS);
});

test('a 1,500-card scene is captured by the canvas painter and never by the slow DOM converter', async () => {
  const domCalls = [];
  const canvasCalls = [];
  const imageResources = { ...IMAGE_RESOURCES_FAKE };
  const fixture = captureFixture(async (...args) => { domCalls.push(args); return makeBlob('dom'); }, undefined, {
    imageResources,
    toCanvasBlob: async (...args) => { canvasCalls.push(args); return makeBlob('canvas'); },
  });
  try {
    const scene = sceneWithItems(1500);
    await fixture.capture.capture(scene, 'big board');
    assert.equal(domCalls.length, 0);
    assert.equal(canvasCalls.length, 1);
    assert.equal(canvasCalls[0][0], scene);
    assert.equal(canvasCalls[0][1].imageResources, imageResources);
    assert.ok(canvasCalls[0][1].signal instanceof AbortSignal);
    assert.equal(await fixture.created[0].text(), 'canvas');
    assert.deepEqual(fixture.capture.state, { imageUrl: 'blob:snapshot-1', status: 'ready' });
  } finally { fixture.capture.dispose(); }
});

test('small boards keep the exact DOM conversion and an empty canvas image is reported unavailable', async () => {
  const domCalls = [];
  const small = captureFixture(async (...args) => { domCalls.push(args); return makeBlob('dom'); }, undefined, {
    toCanvasBlob: async () => assert.fail('small boards must not use the canvas painter'),
  });
  const empty = captureFixture(async () => assert.fail('large boards must not use DOM conversion'), undefined, {
    toCanvasBlob: async () => new Blob([], { type: 'image/png' }),
  });
  try {
    await small.capture.capture(sceneWithItems(PUBLIC_DOM_RASTER_MAX_ITEMS), 'small board');
    assert.equal(domCalls.length, 1);
    await empty.capture.capture(sceneWithItems(PUBLIC_DOM_RASTER_MAX_ITEMS + 1), 'large board');
    assert.deepEqual(empty.capture.state, { imageUrl: null, status: 'unavailable' });
    assert.equal(empty.created.length, 0);
  } finally { small.capture.dispose(); empty.capture.dispose(); }
});
