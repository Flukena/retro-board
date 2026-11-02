import { createRequire } from 'node:module';
import { isSafeId } from '../domain/comment-schema.js';
import { PUBLIC_ITEM_TYPES, PUBLIC_CREATION_WINDOW_MS, PUBLIC_CREATIONS_PER_WINDOW, PUBLIC_IMAGES_PER_WINDOW, PUBLIC_QUOTA_MESSAGE_TYPE } from '../domain/public-wall-contract.js';

const require = createRequire(import.meta.url);
const decoding = require('lib0/decoding');
const encoding = require('lib0/encoding');
const WEBSOCKET_OPEN = 1;
const MAX_IP_BUCKETS = 10_000;
const ITEM_TYPES = new Set(PUBLIC_ITEM_TYPES);

export function publicSyncUpdate(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const decoder = decoding.createDecoder(bytes);
  decoding.readVarUint(decoder);
  decoding.readVarUint(decoder);
  return decoding.readVarUint8Array(decoder);
}

export class PublicActionLimit {
  #Y;
  #doc;
  #shadow;
  #buckets = new Map();
  #changes = null;
  #onUpdate;
  #clients = new Map();
  #lastAcceptedIds = [];

  constructor(Y, doc) {
    this.#Y = Y;
    this.#doc = doc;
    this.#reset();
    this.#onUpdate = update => Y.applyUpdate(this.#shadow, update);
    doc.on('update', this.#onUpdate);
  }

  #reset() {
    this.#shadow?.destroy();
    this.#shadow = new this.#Y.Doc();
    this.#Y.applyUpdate(this.#shadow, this.#Y.encodeStateAsUpdate(this.#doc));
    this.#shadow.getMap('items').observeDeep(events => this.#observe(events));
  }

  #observe(events) {
    if (!this.#changes) return;
    for (const event of events) {
      if (event.path.length === 0) {
        for (const [id, change] of event.changes.keys) {
          if (change.action !== 'delete') this.#changes.created.add(id);
        }
      } else if (event.path.length === 1 && event.keysChanged?.has('type')) {
        const change = event.changes.keys.get('type');
        if (change?.oldValue !== event.target.get('type')) this.#changes.typeChanged.add(event.path[0]);
      }
    }
  }

  #cost() {
    const items = this.#shadow.getMap('items');
    let images = 0;
    for (const id of this.#changes.created) {
      if (!isSafeId(id)) return null;
      const item = items.get(id);
      const type = item instanceof this.#Y.Map ? item.get('type') : undefined;
      if (!ITEM_TYPES.has(type)) return null;
      if (type === 'image') images += 1;
    }
    if ([...this.#changes.typeChanged].some(id => !this.#changes.created.has(id))) return null;
    return { creations: this.#changes.created.size, images, ids: [...this.#changes.created] };
  }

  #take(ip, cost, now) {
    if (!cost.creations) return true;
    let bucket = this.#buckets.get(ip);
    if (!bucket) {
      if (this.#buckets.size >= MAX_IP_BUCKETS) {
        for (const [key, entry] of this.#buckets) {
          if (entry.at(-1).time + PUBLIC_CREATION_WINDOW_MS <= now) this.#buckets.delete(key);
        }
        if (this.#buckets.size >= MAX_IP_BUCKETS) return false;
      }
      bucket = [];
    }
    bucket = bucket.filter(entry => entry.time + PUBLIC_CREATION_WINDOW_MS > now);
    const creations = bucket.reduce((sum, entry) => sum + entry.creations, 0);
    const images = bucket.reduce((sum, entry) => sum + entry.images, 0);
    if (creations + cost.creations > PUBLIC_CREATIONS_PER_WINDOW || images + cost.images > PUBLIC_IMAGES_PER_WINDOW) return false;
    bucket.push({ time: now, creations: cost.creations, images: cost.images });
    this.#buckets.set(ip, bucket);
    return true;
  }

  admit(ip, update, now = Date.now()) {
    this.#changes = { created: new Set(), typeChanged: new Set() };
    this.#lastAcceptedIds = [];
    let admitted = false;
    try {
      this.#Y.applyUpdate(this.#shadow, update);
      const cost = this.#cost();
      admitted = Boolean(cost) && !this.#shadow.store.pendingStructs && !this.#shadow.store.pendingDs
        && this.#take(ip, cost, now);
      if (admitted) this.#lastAcceptedIds = cost.ids;
    } finally {
      this.#changes = null;
      if (!admitted) this.#reset();
    }
    return admitted;
  }

  #sendQuota(ip, socket, acceptedIds = []) {
    if (socket.readyState !== WEBSOCKET_OPEN) return;
    const now = Date.now();
    const entries = (this.#buckets.get(ip) || []).filter(entry => entry.time + PUBLIC_CREATION_WINDOW_MS > now)
      .map(entry => ({ creations: entry.creations, images: entry.images,
        remainingMs: entry.time + PUBLIC_CREATION_WINDOW_MS - now }));
    const frame = encoding.createEncoder();
    encoding.writeVarUint(frame, PUBLIC_QUOTA_MESSAGE_TYPE);
    encoding.writeVarString(frame, JSON.stringify({ entries, acceptedIds }));
    socket.send(encoding.toUint8Array(frame));
  }

  register(ip, socket) {
    let clients = this.#clients.get(ip);
    if (!clients) { clients = new Set(); this.#clients.set(ip, clients); }
    clients.add(socket);
    socket.once('close', () => {
      clients.delete(socket);
      if (!clients.size) this.#clients.delete(ip);
    });
    this.#sendQuota(ip, socket);
  }

  notify(ip, sender) {
    if (!this.#lastAcceptedIds.length) return;
    for (const socket of this.#clients.get(ip) || []) {
      this.#sendQuota(ip, socket, socket === sender ? this.#lastAcceptedIds : []);
    }
    this.#lastAcceptedIds = [];
  }

  destroy() {
    this.#doc.off('update', this.#onUpdate);
    this.#shadow.destroy();
  }
}

const publicPolicies = new WeakMap();
function publicPolicy(Y, doc) {
  let policy = publicPolicies.get(doc);
  if (!policy) {
    policy = new PublicActionLimit(Y, doc);
    publicPolicies.set(doc, policy);
    doc.once('destroy', () => policy.destroy());
  }
  return policy;
}
export function registerPublicQuotaClient(Y, doc, ip, socket) {
  publicPolicy(Y, doc).register(ip, socket);
}
export function admitPublicAction(Y, doc, ip, data) {
  return publicPolicy(Y, doc).admit(ip, publicSyncUpdate(data));
}
export function notifyPublicQuota(doc, ip, socket) {
  publicPolicies.get(doc)?.notify(ip, socket);
}
