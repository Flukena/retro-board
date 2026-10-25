import { toBlob as rasterizeScene } from 'html-to-image';
import { SnapshotImageResources, blobDataURL } from './snapshot-image-resource.js';
import { PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX, PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX } from '../../domain/public-wall-contract.js';

export { PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX, PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX };
const SNAPSHOT_PIXEL_RATIO = 1;
const FONT_CSS_PATH = '/fonts/board-snapshot/fonts.css';
const FONT_RESOURCE_TIMEOUT_MS = 10_000;
const SNAPSHOT_RENDER_TIMEOUT_MS = 15_000;
const FONT_URL_PATTERN = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
let embeddedFontCSS;

async function fetchResource(url, fetcher) {
  const response = await fetcher(url, {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(FONT_RESOURCE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Board snapshot font resource unavailable');
  return response;
}

async function fontDataURL(response) {
  const blob = await response.blob();
  return blobDataURL(blob.type ? blob : new Blob([blob], { type: 'font/woff2' }));
}

export async function embedSnapshotFonts(css, cssURL, fetcher = fetch) {
  const stylesheet = new URL(cssURL);
  const sources = [...new Set(Array.from(css.matchAll(FONT_URL_PATTERN), match => match[1]))];
  const embedded = new Map(await Promise.all(sources.map(async source => {
    const url = new URL(source, stylesheet);
    if (url.origin !== stylesheet.origin) throw new Error('Snapshot fonts must use the same origin');
    return [source, await fontDataURL(await fetchResource(url.href, fetcher))];
  })));
  return css.replace(FONT_URL_PATTERN, (_, source) => `url("${embedded.get(source)}")`);
}

export function loadSnapshotFontCSS() {
  if (!embeddedFontCSS) {
    embeddedFontCSS = (async () => {
      const cssURL = new URL(FONT_CSS_PATH, window.location.origin).href;
      const response = await fetchResource(cssURL, fetch);
      return embedSnapshotFonts(await response.text(), cssURL);
    })().then(undefined, error => {
      embeddedFontCSS = undefined;
      throw error;
    });
  }
  return embeddedFontCSS;
}

function imageOptions(fontEmbedCSS) {
  return {
    width: PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX,
    height: PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX,
    canvasWidth: PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX,
    canvasHeight: PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX,
    pixelRatio: SNAPSHOT_PIXEL_RATIO,
    cacheBust: false,
    fontEmbedCSS,
    fetchRequestInit: { credentials: 'omit', redirect: 'error' },
    style: { position: 'relative', left: '0px', top: '0px', transform: 'none', margin: '0px', insetBlock: '0px auto', insetInline: '0px auto' },
  };
}

export class SnapshotImageCapture extends EventTarget {
  #toBlob;
  #loadFontCSS;
  #urls;
  #imageResources;
  #state = Object.freeze({ imageUrl: null, status: 'loading' });
  #revision = Symbol('initial snapshot');
  #generation = 0;
  #pending = null;
  #task = null;
  #disposed = false;
  #renderController = null;

  constructor({ toBlob = rasterizeScene, loadFontCSS = loadSnapshotFontCSS, urlApi = URL, imageResources = new SnapshotImageResources() } = {}) {
    super();
    this.#toBlob = toBlob;
    this.#loadFontCSS = loadFontCSS;
    this.#urls = urlApi;
    this.#imageResources = imageResources;
  }

  get state() { return this.#state; }

  capture(node, revision) {
    const unchanged = revision === this.#revision && this.#state.status !== 'unavailable';
    if (this.#disposed || !node || unchanged) return this.#task ?? Promise.resolve();
    this.#revision = revision;
    this.#generation += 1;
    this.#pending = { node, generation: this.#generation };
    this.#publish(this.#state.imageUrl, 'loading');
    this.#task ??= this.#drain().finally(() => { this.#task = null; });
    return this.#task;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pending = null;
    this.#renderController?.abort();
    this.#imageResources.dispose();
    if (this.#state.imageUrl) this.#urls.revokeObjectURL(this.#state.imageUrl);
    this.#state = Object.freeze({ imageUrl: null, status: 'unavailable' });
  }

  #publish(imageUrl, status) {
    this.#state = Object.freeze({ imageUrl, status });
    this.dispatchEvent(new Event('change'));
  }

  async #render(job, signal) {
    const fontCSS = await this.#loadFontCSS();
    signal.throwIfAborted();
    const prepared = await this.#imageResources.prepare(job.node, signal);
    try {
      signal.throwIfAborted();
      const blob = await this.#toBlob(prepared.node, imageOptions(fontCSS));
      if (!blob || !blob.size) throw new Error('Board snapshot conversion produced no image');
      return blob;
    } finally { prepared.dispose(); }
  }

  #renderWithinDeadline(job) {
    const controller = new AbortController();
    this.#renderController = controller;
    const deadline = setTimeout(() => controller.abort(new Error('Board snapshot render timed out')), SNAPSHOT_RENDER_TIMEOUT_MS);
    let onAbort;
    return new Promise((resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      this.#render(job, controller.signal).then(resolve, reject);
    }).finally(() => {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', onAbort);
      this.#renderController = null;
    });
  }

  async #drain() {
    while (this.#pending && !this.#disposed) {
      const job = this.#pending;
      this.#pending = null;
      const [result] = await Promise.allSettled([this.#renderWithinDeadline(job)]);
      if (this.#disposed || job.generation !== this.#generation) continue;
      if (result.status === 'rejected') {
        this.#publish(this.#state.imageUrl, 'unavailable');
        continue;
      }
      const previousURL = this.#state.imageUrl;
      this.#publish(this.#urls.createObjectURL(result.value), 'ready');
      if (previousURL) this.#urls.revokeObjectURL(previousURL);
    }
  }
}
