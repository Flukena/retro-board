import { VIEWPORT_ZOOM_MIN, VIEWPORT_ZOOM_MAX } from '../../domain/viewport-limits.js';
import { isSafeId } from '../../domain/comment-schema.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  IMPORT_COORDINATE_MAX_ABS,
} from '../../domain/security-boundaries.js';

export const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const normalizeStoredUserId = (value) => (isSafeId(value) ? value : null);

export const normalizeDisplayName = (value) => (
  typeof value === 'string' ? value.trim().slice(0, DISPLAY_NAME_MAX_LENGTH) : ''
);

export const normalizeViewport = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_VIEWPORT };
  }
  const { x, y, zoom } = value;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) {
    return { ...DEFAULT_VIEWPORT };
  }
  return {
    x: clamp(x, -IMPORT_COORDINATE_MAX_ABS, IMPORT_COORDINATE_MAX_ABS),
    y: clamp(y, -IMPORT_COORDINATE_MAX_ABS, IMPORT_COORDINATE_MAX_ABS),
    zoom: clamp(zoom, VIEWPORT_ZOOM_MIN, VIEWPORT_ZOOM_MAX),
  };
};

export const LOCAL_ONLY_KEYS = new Set(['viewport']);

export function readLocalPreference(key, storage) {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    // Missing, corrupt or unavailable storage means use the initial viewport.
    return null;
  }
}

export function writeLocalPreference(key, value, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // A device preference is expendable; never fall back to the shared room.
    return false;
  }
}
