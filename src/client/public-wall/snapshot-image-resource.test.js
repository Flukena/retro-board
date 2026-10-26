import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SnapshotImageCapture } from './public-wall-snapshot-image.js';
import { SnapshotImageResources, SNAPSHOT_IMAGE_CACHE_MAX_ENTRIES } from './snapshot-image-resource.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const ORIGIN = 'https://retroroom.party';
const EXPECTED_RENDER_TIMEOUT_MS = 15_000;
const imagePath = id => `/yjs-public/rooms/${'A'.repeat(32)}/images/${id.toString(16).padStart(8, '0')}.png`;
const response = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

class Element {
  constructor(document, tagName = 'div') {
    this.ownerDocument = document;
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.style = { setProperty(name, value) { this[name] = value; } };
  }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  set src(value) { this.setAttribute('src', value); }
  get src() { return this.getAttribute('src'); }
  decode() { return this.ownerDocument.decode(this); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
      .filter(child => selector === '*' || child.tagName === selector);
  }
  cloneNode() {
    const copy = new Element(this.ownerDocument, this.tagName);
    copy.attributes = new Map(this.attributes);
    this.children.forEach(child => copy.appendChild(child.cloneNode(true)));
    return copy;
  }
}

function sceneFixture(paths = [imagePath(1)]) {
  const decoded = [];
  const document = {
    baseURI: `${ORIGIN}/`,
    decode(image) { decoded.push(image); return Promise.resolve(); },
    createElement(tag) { return new Element(document, tag); },
    defaultView: { getComputedStyle() {
      return Object.assign(['font-family', 'color'], {
        getPropertyValue: property => property === 'color' ? 'rgb(1, 2, 3)' : 'Sarabun',
        getPropertyPriority: () => '',
      });
    } },
  };
  document.body = new Element(document, 'body');
  const scene = document.body.appendChild(new Element(document));
  paths.forEach(path => { const image = scene.appendChild(new Element(document, 'img')); image.src = path; });
  return { scene, document, decoded };
}

test('429 is not cached; retry embeds only decoded data URLs and leaves the original scene unchanged', async () => {
  const { scene, document, decoded } = sceneFixture();
  const requests = [];
  const resources = new SnapshotImageResources({ fetcher: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? new Response('busy', { status: 429 }) : response();
  } });
  const signal = new AbortController().signal;
  await assert.rejects(resources.prepare(scene, signal), /unavailable/);
  assert.equal(document.body.children.length, 1);
  const prepared = await resources.prepare(scene, signal);
  assert.notEqual(prepared.node, scene);
  assert.match(prepared.node.querySelectorAll('img')[0].src, /^data:image\/png;base64,/);
  assert.equal(prepared.node.style['font-family'], 'Sarabun');
  assert.equal(scene.querySelectorAll('img')[0].src, imagePath(1));
  assert.equal(document.body.children.length, 2);
  assert.equal(decoded[0].src, null);
  prepared.dispose();
  assert.equal(document.body.children.length, 1);
  const cached = await resources.prepare(scene, signal);
  cached.dispose();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, `${ORIGIN}${imagePath(1)}`);
  assert.equal(requests[1].options.credentials, 'omit');
  assert.equal(requests[1].options.redirect, 'error');
  resources.dispose();
});

test('only exact same-origin public raster routes are fetched', async () => {
  let requests = 0;
  const resources = new SnapshotImageResources({ fetcher: async () => { requests++; return response(); } });
  const invalid = [`https://elsewhere.test${imagePath(1)}`, '/yjs/rooms/private/images/abcdef01.png',
    imagePath(1).replace('/yjs-public', ''), `${imagePath(1)}?retry=1`, `${imagePath(1)}#fragment`,
    `/ignored/..${imagePath(1)}`, ` ${imagePath(1)}`, `https://user@retroroom.party${imagePath(1)}`,
    'data:image/png;base64,AAAA', 'blob:https://retroroom.party/test'];
  for (const path of invalid) {
    const { scene, document } = sceneFixture([path]);
    await assert.rejects(resources.prepare(scene, new AbortController().signal));
    assert.equal(document.body.children.length, 1);
  }
  assert.equal(requests, 0);
  resources.dispose();
});

test('invalid raster and browser decode failure never enter the successful cache', async () => {
  const { scene, document } = sceneFixture();
  let calls = 0;
  const resources = new SnapshotImageResources({ fetcher: async () => {
    calls++;
    return calls === 1 ? new Response('invalid', { headers: { 'content-type': 'image/png' } }) : response();
  } });
  const signal = new AbortController().signal;
  await assert.rejects(resources.prepare(scene, signal), /invalid/);
  document.decode = async () => { throw new Error('decode failed'); };
  await assert.rejects(resources.prepare(scene, signal), /decode failed/);
  document.decode = async () => {};
  const prepared = await resources.prepare(scene, signal);
  assert.equal(calls, 3);
  prepared.dispose();
  resources.dispose();
});

test('aborting or disposing removes prepared clones and disposal prevents future captures', async () => {
  const { scene, document } = sceneFixture();
  const resources = new SnapshotImageResources({ fetcher: async () => response() });
  const controller = new AbortController();
  await resources.prepare(scene, controller.signal);
  controller.abort();
  assert.equal(document.body.children.length, 1);
  await resources.prepare(scene, new AbortController().signal);
  resources.dispose();
  assert.equal(document.body.children.length, 1);
  await assert.rejects(resources.prepare(scene, new AbortController().signal), /disposed/);
});

test('resource fetch concurrency is bounded and disposal aborts outstanding requests', async () => {
  const { scene, document } = sceneFixture([1, 2, 3, 4].map(imagePath));
  let requests = 0;
  const signals = [];
  const resources = new SnapshotImageResources({ fetcher: (url, { signal }) => {
    requests++;
    signals.push(signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = resources.prepare(scene, new AbortController().signal);
  await nextTurn();
  assert.equal(requests, 3);
  resources.dispose();
  await assert.rejects(pending);
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.equal(document.body.children.length, 1);
});

test('successful image cache evicts least recently used entries at its bounded entry limit', async () => {
  let calls = 0;
  const resources = new SnapshotImageResources({ fetcher: async () => { calls++; return response(); } });
  const signal = new AbortController().signal;
  for (let index = 0; index <= SNAPSHOT_IMAGE_CACHE_MAX_ENTRIES; index++) {
    const prepared = await resources.prepare(sceneFixture([imagePath(index)]).scene, signal);
    prepared.dispose();
  }
  const prepared = await resources.prepare(sceneFixture([imagePath(0)]).scene, signal);
  prepared.dispose();
  assert.equal(calls, SNAPSHOT_IMAGE_CACHE_MAX_ENTRIES + 2);
  resources.dispose();
});

test('capture preserves the previous PNG on 429 and retries the same revision with embedded images only', async () => {
  const { scene, document } = sceneFixture();
  let calls = 0;
  let unavailable = false;
  const resources = new SnapshotImageResources({ fetcher: async () => {
    calls++;
    return unavailable ? new Response('busy', { status: 429 }) : response();
  } });
  let renders = 0;
  const renderedSources = [];
  const revoked = [];
  const capture = new SnapshotImageCapture({
    imageResources: resources,
    loadFontCSS: async () => '',
    toBlob: async node => {
      renders++;
      renderedSources.push(node.querySelectorAll('img')[0].src);
      return new Blob(['actual scene'], { type: 'image/png' });
    },
    urlApi: { createObjectURL: () => `blob:ready-${renders}`, revokeObjectURL: url => revoked.push(url) },
  });
  try {
    await capture.capture(scene, 'prior');
    assert.deepEqual(capture.state, { imageUrl: 'blob:ready-1', status: 'ready' });
    scene.querySelectorAll('img')[0].src = imagePath(2);
    unavailable = true;
    await capture.capture(scene, 'next');
    assert.deepEqual(capture.state, { imageUrl: 'blob:ready-1', status: 'unavailable' });
    assert.deepEqual(revoked, []);
    assert.equal(document.body.children.length, 1);
    unavailable = false;
    await capture.capture(scene, 'next');
    await capture.capture(scene, 'next');
    assert.deepEqual(capture.state, { imageUrl: 'blob:ready-2', status: 'ready' });
    assert.equal(calls, 3);
    assert.equal(renders, 2);
    renderedSources.forEach(source => assert.match(source, /^data:image\/png;base64,/));
    assert.deepEqual(revoked, ['blob:ready-1']);
    assert.equal(document.body.children.length, 1);
  } finally { capture.dispose(); resources.dispose(); }
});

test('aborting a stalled browser decoder settles preparation and cleans its temporary source', async () => {
  const { scene, document } = sceneFixture();
  let decoding;
  document.decode = image => { decoding = image; return new Promise(() => {}); };
  const resources = new SnapshotImageResources({ fetcher: async () => response() });
  const controller = new AbortController();
  const prepared = resources.prepare(scene, controller.signal);
  await nextTurn();
  controller.abort(new Error('deadline'));
  const outcome = await Promise.race([
    prepared.then(() => 'unexpected ready', error => error.message),
    nextTurn().then(() => 'still stalled'),
  ]);
  assert.equal(outcome, 'deadline');
  assert.equal(decoding.src, null);
  assert.equal(document.body.children.length, 1);
  resources.dispose();
});

test('encoded-byte budget evicts successful cache entries and rejects oversized multi-image captures', async () => {
  const LARGE_IMAGE_BYTES = 4 * 1024 * 1024;
  const paddedPNG = Buffer.alloc(LARGE_IMAGE_BYTES);
  PNG.copy(paddedPNG);
  let calls = 0;
  const resources = new SnapshotImageResources({ fetcher: async () => {
    calls++;
    return new Response(paddedPNG, { headers: { 'content-type': 'image/png' } });
  } });
  const signal = new AbortController().signal;
  for (const id of [1, 2, 1]) {
    const prepared = await resources.prepare(sceneFixture([imagePath(id)]).scene, signal);
    prepared.dispose();
  }
  assert.equal(calls, 3, 'two large data URLs cannot remain cached together');
  const { scene, document } = sceneFixture([imagePath(1), imagePath(2)]);
  await assert.rejects(resources.prepare(scene, signal), /capture memory budget/);
  assert.equal(document.body.children.length, 1);
  resources.dispose();
});

test('capture deadline removes an attached image clone even when the converter never settles', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { scene, document } = sceneFixture();
  let started;
  const rendering = new Promise(resolve => { started = resolve; });
  const resources = new SnapshotImageResources({ fetcher: async () => response() });
  const capture = new SnapshotImageCapture({
    imageResources: resources,
    loadFontCSS: async () => '',
    toBlob: () => { started(); return new Promise(() => {}); },
  });
  try {
    const completed = capture.capture(scene, 'stalled');
    await rendering;
    assert.equal(document.body.children.length, 2);
    context.mock.timers.tick(EXPECTED_RENDER_TIMEOUT_MS);
    await completed;
    assert.deepEqual(capture.state, { imageUrl: null, status: 'unavailable' });
    assert.equal(document.body.children.length, 1);
  } finally { capture.dispose(); resources.dispose(); }
});

test('repeated copies of one large image count toward serialized capture bytes before cloning', async () => {
  const LARGE_IMAGE_BYTES = 5 * 1024 * 1024;
  const REPEATED_IMAGE_COUNT = 100;
  const paddedPNG = Buffer.alloc(LARGE_IMAGE_BYTES);
  PNG.copy(paddedPNG);
  const { scene, document } = sceneFixture(Array(REPEATED_IMAGE_COUNT).fill(imagePath(1)));
  let fetches = 0;
  let clones = 0;
  scene.cloneNode = () => { clones++; throw new Error('must reject before cloning'); };
  const resources = new SnapshotImageResources({ fetcher: async () => {
    fetches++;
    return new Response(paddedPNG, { headers: { 'content-type': 'image/png' } });
  } });
  try {
    await assert.rejects(resources.prepare(scene, new AbortController().signal), /capture memory budget/);
    assert.equal(fetches, 1);
    assert.equal(clones, 0);
    assert.equal(document.body.children.length, 1);
  } finally { resources.dispose(); }
});

test('default fetch preserves the browser global receiver required by WebIDL', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = function () {
    assert.equal(this, globalThis, 'Window.fetch requires its global receiver');
    calls++;
    return Promise.resolve(response());
  };
  const resources = new SnapshotImageResources();
  try {
    const prepared = await resources.prepare(sceneFixture().scene, new AbortController().signal);
    prepared.dispose();
    assert.equal(calls, 1);
  } finally { resources.dispose(); globalThis.fetch = originalFetch; }
});

test('canvas snapshots get decoded images by public URL without cloning the scene', async () => {
  const { scene, document } = sceneFixture([imagePath(1), imagePath(2), imagePath(1)]);
  let requests = 0;
  const resources = new SnapshotImageResources({ fetcher: async () => { requests++; return response(); } });
  const images = await resources.decodedImages(scene, new AbortController().signal);
  assert.deepEqual([...images.keys()], [`${ORIGIN}${imagePath(1)}`, `${ORIGIN}${imagePath(2)}`]);
  for (const image of images.values()) assert.match(image.src, /^data:image\/png;base64,/, 'decoded image stays drawable');
  assert.equal(requests, 2, 'repeated images are fetched once');
  assert.equal(document.body.children.length, 1, 'no scene clone is attached');
  const empty = sceneFixture([]);
  assert.deepEqual(await resources.decodedImages(empty.scene, new AbortController().signal), new Map());
  const invalid = sceneFixture(['/yjs/rooms/private/images/abcdef01.png']);
  await assert.rejects(resources.decodedImages(invalid.scene, new AbortController().signal));
  resources.dispose();
  await assert.rejects(resources.decodedImages(scene, new AbortController().signal), /disposed/);
});
