import { canonicalPublicImageSource } from '../../domain/public-wall-image-source.js';
import { IMAGE_MAX_BYTES, isSafeImageMime, inspectRasterImageBlob, imageInfoIsWithinLimits } from '../../domain/security-boundaries.js';
import { PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX } from '../../domain/public-wall-contract.js';

export const SNAPSHOT_IMAGE_CACHE_MAX_ENTRIES = 64;
export const SNAPSHOT_IMAGE_CACHE_MAX_ENCODED_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_IMAGE_CAPTURE_MAX_ENCODED_BYTES = SNAPSHOT_IMAGE_CACHE_MAX_ENCODED_BYTES;
const SNAPSHOT_IMAGE_FETCH_CONCURRENCY = 3;
const BASE64_CHUNK_BYTES = 32_768;
const STRING_BYTES_PER_CHARACTER = 2;

export async function blobDataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export function publicImageURL(source, document) {
  const url = new URL(source, document.baseURI);
  const page = new URL(document.baseURI);
  const canonical = canonicalPublicImageSource(source);
  if (url.origin !== page.origin || !canonical || url.pathname !== canonical) {
    throw new Error('Snapshot images must use a same-origin public room image route');
  }
  return url.href;
}

async function boundedImageBlob(response, signal) {
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!response.ok || !isSafeImageMime(mime)) {
    await response.body?.cancel();
    throw new Error('Public snapshot image is unavailable');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > IMAGE_MAX_BYTES) throw new Error('Public snapshot image exceeds the byte limit');
      chunks.push(chunk.value);
    }
    return new Blob(chunks, { type: mime });
  } finally {
    await Promise.allSettled([reader.cancel()]);
    reader.releaseLock();
  }
}

async function decodedImage(dataURL, document, signal) {
  const image = document.createElement('img');
  let cancel;
  try {
    signal.throwIfAborted();
    image.src = dataURL;
    await new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      image.decode().then(resolve, reject);
    });
    signal.throwIfAborted();
    return image;
  } catch (error) {
    image.removeAttribute('src');
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function decodeImage(dataURL, document, signal) {
  (await decodedImage(dataURL, document, signal)).removeAttribute('src');
}

const sceneImageSources = node => Array.from(node.querySelectorAll('img'),
  image => publicImageURL(image.getAttribute('src'), node.ownerDocument));

function styledClone(node, images) {
  const clone = node.cloneNode(true);
  const originals = [node, ...node.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  originals.forEach((original, index) => {
    const computed = node.ownerDocument.defaultView.getComputedStyle(original);
    for (const property of Array.from(computed)) {
      copies[index].style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }
  });
  const originalImages = Array.from(node.querySelectorAll('img'));
  Array.from(clone.querySelectorAll('img')).forEach((image, index) => {
    const url = publicImageURL(originalImages[index].getAttribute('src'), node.ownerDocument);
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.src = images.get(url);
  });
  clone.style.position = 'fixed';
  clone.style.left = `${-PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX}px`;
  clone.style.top = '0px';
  clone.style.pointerEvents = 'none';
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  return clone;
}

export class SnapshotImageResources {
  #fetcher;
  #cache = new Map();
  #cachedBytes = 0;
  #active = new Set();
  #disposed = false;

  constructor({ fetcher = globalThis.fetch.bind(globalThis) } = {}) { this.#fetcher = fetcher; }

  #remember(url, dataURL) {
    const bytes = dataURL.length * STRING_BYTES_PER_CHARACTER;
    if (bytes > SNAPSHOT_IMAGE_CACHE_MAX_ENCODED_BYTES) return { dataURL, bytes };
    while (this.#cache.size >= SNAPSHOT_IMAGE_CACHE_MAX_ENTRIES
      || this.#cachedBytes + bytes > SNAPSHOT_IMAGE_CACHE_MAX_ENCODED_BYTES) {
      const oldest = this.#cache.keys().next().value;
      this.#cachedBytes -= this.#cache.get(oldest).bytes;
      this.#cache.delete(oldest);
    }
    const value = { dataURL, bytes };
    this.#cache.set(url, value);
    this.#cachedBytes += bytes;
    return value;
  }

  async #image(url, document, signal) {
    signal.throwIfAborted();
    const existing = this.#cache.get(url);
    if (existing) { this.#cache.delete(url); this.#cache.set(url, existing); return existing; }
    const response = await this.#fetcher(url, { credentials: 'omit', redirect: 'error', signal });
    const blob = await boundedImageBlob(response, signal);
    if (!imageInfoIsWithinLimits(await inspectRasterImageBlob(blob))) throw new Error('Public snapshot image is invalid');
    const dataURL = await blobDataURL(blob);
    await decodeImage(dataURL, document, signal);
    signal.throwIfAborted();
    return this.#remember(url, dataURL);
  }

  async #images(sources, document, controller) {
    const occurrences = new Map();
    for (const source of sources) occurrences.set(source, (occurrences.get(source) ?? 0) + 1);
    const urls = [...occurrences.keys()];
    let next = 0;
    let bytes = 0;
    const images = new Map();
    const workers = Array.from({ length: Math.min(SNAPSHOT_IMAGE_FETCH_CONCURRENCY, urls.length) }, async () => {
      while (next < urls.length && !controller.signal.aborted) {
        const url = urls[next++];
        await this.#image(url, document, controller.signal).then(image => {
          bytes += image.bytes * occurrences.get(url);
          if (bytes > SNAPSHOT_IMAGE_CAPTURE_MAX_ENCODED_BYTES) {
            const error = new Error('Public snapshot images exceed the capture memory budget');
            controller.abort(error);
            throw error;
          }
          images.set(url, image.dataURL);
        }, error => { controller.abort(error); throw error; });
      }
    });
    const results = await Promise.allSettled(workers);
    controller.signal.throwIfAborted();
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return images;
  }

  // An abort controller tied to the caller's signal and tracked for disposal.
  #link(signal) {
    if (this.#disposed) throw new Error('Snapshot image resources have been disposed');
    const controller = new AbortController();
    this.#active.add(controller);
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const release = () => {
      signal.removeEventListener('abort', abort);
      controller.abort();
      this.#active.delete(controller);
    };
    return { controller, release };
  }

  async prepare(node, signal) {
    if (this.#disposed) throw new Error('Snapshot image resources have been disposed');
    const sources = sceneImageSources(node);
    if (!sources.length) return { node, dispose() {} };
    const { controller, release } = this.#link(signal);
    let clone;
    let ready = false;
    let released = false;
    const dispose = () => {
      if (released) return;
      released = true;
      clone?.remove();
      release();
    };
    controller.signal.addEventListener('abort', dispose, { once: true });
    try {
      const images = await this.#images(sources, node.ownerDocument, controller);
      controller.signal.throwIfAborted();
      clone = styledClone(node, images);
      node.ownerDocument.body.appendChild(clone);
      ready = true;
      return { node: clone, dispose };
    } finally { if (!ready) dispose(); }
  }

  /** Decoded uploaded images of a scene, keyed by public URL, without cloning the scene. */
  async decodedImages(node, signal) {
    if (this.#disposed) throw new Error('Snapshot image resources have been disposed');
    const sources = sceneImageSources(node);
    if (!sources.length) return new Map();
    const { controller, release } = this.#link(signal);
    try {
      const dataURLs = await this.#images(sources, node.ownerDocument, controller);
      const decoded = await Promise.all(Array.from(dataURLs, async ([url, dataURL]) => (
        [url, await decodedImage(dataURL, node.ownerDocument, controller.signal)])));
      return new Map(decoded);
    } finally { release(); }
  }

  dispose() {
    this.#disposed = true;
    for (const controller of this.#active) controller.abort();
    this.#active.clear();
    this.#cache.clear();
    this.#cachedBytes = 0;
  }
}
