import { isSafeId } from '../../domain/comment-schema.js';
import { PUBLIC_CREATION_WINDOW_MS, PUBLIC_CREATIONS_PER_WINDOW, PUBLIC_IMAGES_PER_WINDOW } from '../../domain/public-wall-contract.js';

export const PUBLIC_CREATION_LIMIT_EVENT = 'retro-public-creation-limit';
const MILLISECONDS_PER_SECOND = 1_000;
const MIN_NOTICE_SECONDS = 1;

const imageCount = items => items.reduce((count, item) => count + Number(item.type === 'image'), 0);
const fits = (count, images) => count <= PUBLIC_CREATIONS_PER_WINDOW && images <= PUBLIC_IMAGES_PER_WINDOW;
const validQuotaEntry = entry => Number.isSafeInteger(entry?.creations) && entry.creations > 0
  && entry.creations <= PUBLIC_CREATIONS_PER_WINDOW && Number.isSafeInteger(entry.images)
  && entry.images >= 0 && entry.images <= entry.creations && Number.isSafeInteger(entry.remainingMs)
  && entry.remainingMs > 0 && entry.remainingMs <= PUBLIC_CREATION_WINDOW_MS;

export class PublicCreationGuard {
  #history = [];
  #serverHistory = [];

  record(items, now = Date.now()) {
    this.#history.push(...items.map(item => ({ id: item.id, time: now, image: item.type === 'image' })));
  }

  applyBudget(budget, now = Date.now()) {
    if (!Array.isArray(budget?.entries) || budget.entries.length > PUBLIC_CREATIONS_PER_WINDOW
      || !budget.entries.every(validQuotaEntry) || !Array.isArray(budget.acceptedIds)
      || budget.acceptedIds.length > PUBLIC_CREATIONS_PER_WINDOW
      || budget.acceptedIds.some(id => !isSafeId(id))) return false;
    const history = [];
    for (const entry of budget.entries) {
      for (let index = 0; index < entry.creations; index += 1) {
        history.push({ time: now - PUBLIC_CREATION_WINDOW_MS + entry.remainingMs, image: index < entry.images });
      }
    }
    if (!fits(history.length, history.filter(entry => entry.image).length)) return false;
    for (const id of budget.acceptedIds) {
      const index = this.#history.findIndex(entry => entry.id === id);
      if (index !== -1) this.#history.splice(index, 1);
    }
    this.#serverHistory = history;
    return true;
  }

  check(items, now = Date.now()) {
    this.#history = this.#history.filter(entry => entry.time + PUBLIC_CREATION_WINDOW_MS > now);
    this.#serverHistory = this.#serverHistory.filter(entry => entry.time + PUBLIC_CREATION_WINDOW_MS > now);
    const history = [...this.#history, ...this.#serverHistory].sort((left, right) => left.time - right.time);
    let count = history.length + items.length;
    let images = history.filter(entry => entry.image).length + imageCount(items);
    if (fits(count, images)) return { allowed: true };
    if (!fits(items.length, imageCount(items))) return { allowed: false, oversized: true, retryAfterSeconds: MIN_NOTICE_SECONDS };
    for (const entry of history) {
      count -= 1;
      images -= Number(entry.image);
      if (fits(count, images)) {
        return { allowed: false, oversized: false,
          retryAfterSeconds: Math.max(MIN_NOTICE_SECONDS, Math.ceil((entry.time + PUBLIC_CREATION_WINDOW_MS - now) / MILLISECONDS_PER_SECOND)) };
      }
    }
    return { allowed: false, oversized: true, retryAfterSeconds: MIN_NOTICE_SECONDS };
  }
}
