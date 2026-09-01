// RetroBoard.jsx — Miro-style retrospective board (single-file artifact)
// Last-write-wins sync via window.storage (no CRDT). Optimistic UI + debounced save.

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import {
  Trash2, Lock, Unlock, Eye, EyeOff, ZoomIn, ZoomOut, Maximize2,
  ThumbsUp, Crown, Clock, Play, Square, LayoutTemplate,
  ChevronDown, X, Sparkles, AlertCircle, Type, Copy,
  Image as ImageIcon, MousePointer2, RotateCcw,
  Languages, Sun, Moon, Monitor, Download, Upload, Undo2, Redo2,
  MoreHorizontal, Ban, Check, BringToFront, SendToBack, HelpCircle,
} from 'lucide-react';
import { t, useLang } from './src/i18n.js';
import { useTheme, nextThemePref } from './src/theme.js';
import { useUserIdentity } from './src/useUserIdentity.js';
import { useAdminRole, ONLINE_WINDOW } from './src/useAdminRole.js';

/* ============================================================
   Constants
   ============================================================ */

const COLORS = [
  { bg: '#fef3c7', border: '#f59e0b', zoneBg: 'rgba(251,191,36,0.12)' }, // yellow
  { bg: '#fecaca', border: '#ef4444', zoneBg: 'rgba(239,68,68,0.10)'  }, // red
  { bg: '#bbf7d0', border: '#22c55e', zoneBg: 'rgba(34,197,94,0.10)'  }, // green
  { bg: '#bae6fd', border: '#0ea5e9', zoneBg: 'rgba(14,165,233,0.10)' }, // blue
  { bg: '#e9d5ff', border: '#a855f7', zoneBg: 'rgba(168,85,247,0.10)' }, // purple
  { bg: '#fed7aa', border: '#f97316', zoneBg: 'rgba(249,115,22,0.10)' }, // orange
];

// Font-color presets shown in the toolbar swatch popover. `null` = auto/default.
const FONT_COLORS = [
  { value: null,      label: 'auto',  swatch: 'linear-gradient(135deg,#111 50%,#fff 50%)' },
  { value: '#111827', label: 'black', swatch: '#111827' },
  { value: '#6b7280', label: 'gray',  swatch: '#6b7280' },
  { value: '#ffffff', label: 'white', swatch: '#ffffff' },
  { value: '#dc2626', label: 'red',   swatch: '#dc2626' },
  { value: '#f97316', label: 'orange',swatch: '#f97316' },
  { value: '#16a34a', label: 'green', swatch: '#16a34a' },
  { value: '#2563eb', label: 'blue',  swatch: '#2563eb' },
  { value: '#9333ea', label: 'purple',swatch: '#9333ea' },
];

// Sticky note backgrounds (COLORS above) are fixed pastels that never follow
// the app theme, unlike var(--text) — pin "auto" sticky text to the
// light-theme text colors instead, since the card's own background is
// always light regardless of dark mode.
const STICKY_AUTO_TEXT = '#111827';
const STICKY_AUTO_TEXT_FAINT = '#9ca3af';

const STICKY_W = 200;
const STICKY_H = 180;
const STICKY_MIN_W = 120;
const STICKY_MIN_H = 100;
const ZONE_MIN_W = 240;
const ZONE_MIN_H = 200;
const IMAGE_MIN_W = 60;
const IMAGE_MIN_H = 40;
const TEXT_W = 400;
const TEXT_H = 80;
const TEXT_MIN_W = 60;
const TEXT_MIN_H = 30;
const IMAGE_MAX_DIM = 1200; // resize larger imports down to this max edge
// Hard cap on accepted image blob size before any resize/upload. Larger
// files are rejected up front so we don't OOM the page decoding them.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// Must match the server's MIME_EXT allowlist (yjs-server.mjs) — anything
// outside this set is rejected by /upload regardless of the resize path.
const UPLOADABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// A full board import writes every item in one Yjs transaction, which the
// WebsocketProvider then sends as a single WS frame. Must stay safely under
// the server's per-frame cap (RL_MAX_BYTES in yjs-server.mjs, 2MB) — legacy
// exports with embedded base64 images get converted back to short URLs
// before this check (see sanitizeImportedImages), but this is the
// belt-and-suspenders net for anything that still doesn't fit.
const IMPORT_MAX_SNAPSHOT_BYTES = 1.5 * 1024 * 1024;
const ZONE_TITLE_H = 40;
const DRAG_THRESHOLD = 4;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3.0;
const SCROLL_WHEEL_ZOOM_KEY = 'rb_scroll_wheel_zoom';
const POLL_SAFETY = 15000; // safety net only — Realtime push is primary
const SAVE_DEBOUNCE = 200;
const TEXT_SAVE_DEBOUNCE = 350;
// Drag/resize push cadence: send granular geometry at most every DRAG_FLUSH_MS
// while moving, plus a trailing flush DRAG_TRAILING_MS after the last move so
// the final position always lands even if the throttle swallowed it.
const DRAG_FLUSH_MS = 60;
const DRAG_TRAILING_MS = 80;
// A just-finished drag stays protected against remote-snapshot overwrite for
// this long after mouseup — covers the window where a concurrent peer write
// (e.g. the vote-finalize auto-sort) can land on the same item with a Yjs
// clock that outranks this client's, even though it happened earlier in
// real time. Mirrors RECENT_AUTHOR_WINDOW_MS below (same class of problem:
// a remote snapshot that doesn't yet reflect what this client just did).
const RECENT_MOVE_WINDOW_MS = 8000;
// Above this many paintable cards (sticky+image) on the board, drop the blurred
// per-card shadows/filters — overlapping blur kernels are the dominant paint
// cost when cards cluster. Cards stay separated by their borders.
const DENSE_CARD_THRESHOLD = 60;

// Built-in templates are evaluated lazily so titles re-localize on lang change.
const getTemplates = () => ({
  retro3: {
    name: t('tmpl.retro3.name'),
    zones: [
      { title: t('tmpl.retro3.well'),    color: 2, x: 0,    y: 0, w: 1140, h: 1560 },
      { title: t('tmpl.retro3.improve'), color: 1, x: 1200, y: 0, w: 1140, h: 1560 },
      { title: t('tmpl.retro3.action'),  color: 3, x: 2400, y: 0, w: 1140, h: 1560 },
    ],
  },
  ssc: {
    name: t('tmpl.ssc.name'),
    zones: [
      { title: '▶️ Start',    color: 2, x: 0,    y: 0, w: 1140, h: 1560 },
      { title: '⏹ Stop',     color: 1, x: 1200, y: 0, w: 1140, h: 1560 },
      { title: '⏩ Continue', color: 3, x: 2400, y: 0, w: 1140, h: 1560 },
    ],
  },
  fourLs: {
    name: t('tmpl.4ls.name'),
    zones: [
      { title: '❤️ Liked',      color: 1, x: 0,    y: 0,    w: 1200, h: 1080 },
      { title: '🧠 Learned',    color: 3, x: 1260, y: 0,    w: 1200, h: 1080 },
      { title: '🫥 Lacked',     color: 5, x: 0,    y: 1140, w: 1200, h: 1080 },
      { title: '💭 Longed for', color: 4, x: 1260, y: 1140, w: 1200, h: 1080 },
    ],
  },
  sailboat: {
    name: t('tmpl.sailboat.name'),
    zones: [
      { title: t('tmpl.sailboat.wind'),   color: 2, x: 0,    y: 0,    w: 1200, h: 1080 },
      { title: t('tmpl.sailboat.anchor'), color: 1, x: 1260, y: 0,    w: 1200, h: 1080 },
      { title: t('tmpl.sailboat.rocks'),  color: 5, x: 0,    y: 1140, w: 1200, h: 1080 },
      { title: t('tmpl.sailboat.island'), color: 3, x: 1260, y: 1140, w: 1200, h: 1080 },
    ],
  },
  retroLoop: {
    name: t('tmpl.loop.name'),
    zones: [
      // Outer wrapper — drag its title bar to move the whole template as one.
      { title: t('tmpl.loop.wrapper'), color: 3, x: 0,    y: 0,   w: 6219, h: 2316 },
      { title: t('tmpl.loop.prev'),    color: 0, x: 171,  y: 456, w: 927,  h: 1440 },
      { title: t('tmpl.loop.good'),    color: 2, x: 1191, y: 351, w: 1140, h: 1560 },
      { title: t('tmpl.loop.bad'),     color: 1, x: 2391, y: 351, w: 1140, h: 1560 },
      { title: t('tmpl.loop.try'),     color: 4, x: 3591, y: 351, w: 1140, h: 1560 },
      { title: t('tmpl.loop.next'),    color: 5, x: 4848, y: 417, w: 1086, h: 1464 },
    ],
  },
});

const TIMER_PRESETS = [1, 3, 5, 10];

// Help modal sections, in display order. `color` indexes COLORS so each
// section's accent dot matches a real sticky-note color from the palette.
const HELP_SECTIONS = [
  { key: 'collab', color: 0 },
  { key: 'canvas', color: 2 },
  { key: 'zones', color: 3 },
  { key: 'reveal', color: 4 },
  { key: 'voting', color: 1 },
  { key: 'admin', color: 5 },
];

const DEFAULT_BOARD = {
  items: [],
  adminUserId: null,
  editingLocked: false,
  // In-session pause for voting. Voting requires an active timer session AND
  // votingLocked === false. Default unlocked so starting a timer enables voting
  // right away; an admin can flip this to pause voting mid-session.
  votingLocked: false,
  allRevealed: false,
  // timer: { startedAt, endsAt: number|null, voteLimit: number|null, hideResults: boolean }
  // - endsAt=null   → no time limit, admin must stop manually
  // - voteLimit=null → unlimited votes per user
  timer: null,
  lastResultsAt: null,
  // SHA-256(boardCode + ':' + pin) — required before destructive admin
  // actions (Clear / Reset votes / Transfer admin). null until the first
  // admin sets one; if still null, the actions just prompt the admin to set
  // a PIN inline rather than blocking access.
  adminPinHash: null,
};

/* ============================================================
   Helpers
   ============================================================ */

const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const effectiveZIndex = (item) => item.zIndex ?? item.createdAt;
const compareZOrder = (a, b) => {
  const delta = effectiveZIndex(a) - effectiveZIndex(b);
  if (delta) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const swapZOrderEntries = (items, index, neighborIndex) => {
  const itemZ = effectiveZIndex(items[index]);
  const neighborZ = effectiveZIndex(items[neighborIndex]);
  const lowerIndex = Math.min(index, neighborIndex);
  const upperIndex = Math.max(index, neighborIndex);
  const lowerGroupZ = effectiveZIndex(items[lowerIndex]);
  const upperGroupZ = effectiveZIndex(items[upperIndex]);
  const touchesTie = lowerGroupZ === upperGroupZ
    || (lowerIndex > 0 && effectiveZIndex(items[lowerIndex - 1]) === lowerGroupZ)
    || (upperIndex < items.length - 1
      && effectiveZIndex(items[upperIndex + 1]) === upperGroupZ);
  if (!touchesTie) {
    return [
      { id: items[index].id, patch: { zIndex: neighborZ } },
      { id: items[neighborIndex].id, patch: { zIndex: itemZ } },
    ];
  }

  // Items created in one batch can share a millisecond timestamp. A raw swap
  // can then be a no-op or cross extra peers in that tie, so give the smallest
  // affected tied range distinct values while preserving all other positions.
  let first = lowerIndex;
  let last = upperIndex;
  while (first > 0 && effectiveZIndex(items[first - 1]) === lowerGroupZ) first -= 1;
  while (last < items.length - 1
    && effectiveZIndex(items[last + 1]) === upperGroupZ) last += 1;

  const reordered = items.slice(first, last + 1);
  const localIndex = index - first;
  const localNeighborIndex = neighborIndex - first;
  [reordered[localIndex], reordered[localNeighborIndex]] = [
    reordered[localNeighborIndex],
    reordered[localIndex],
  ];

  const lowerZ = first > 0 ? effectiveZIndex(items[first - 1]) : null;
  const upperZ = last < items.length - 1 ? effectiveZIndex(items[last + 1]) : null;
  let values;
  if (lowerZ != null && upperZ != null) {
    const step = (upperZ - lowerZ) / (reordered.length + 1);
    values = reordered.map((_, i) => lowerZ + step * (i + 1));
  } else if (lowerZ != null) {
    values = reordered.map((_, i) => lowerGroupZ + i);
  } else if (upperZ != null) {
    values = reordered.map((_, i) => upperGroupZ - (reordered.length - i - 1));
  } else {
    values = reordered.map((_, i) => i);
  }

  const valuesAreOrdered = values.every((value, i) => (
    Number.isFinite(value)
    && (i === 0 || value > values[i - 1])
    && (lowerZ == null || value > lowerZ)
    && (upperZ == null || value < upperZ)
  ));
  if (valuesAreOrdered) {
    return reordered.map((item, i) => ({ id: item.id, patch: { zIndex: values[i] } }));
  }

  // Floating-point values can theoretically leave no representable gap.
  // Reindexing the whole already-sorted stack is the deterministic fallback.
  const fullyReordered = [...items];
  [fullyReordered[index], fullyReordered[neighborIndex]] = [
    fullyReordered[neighborIndex],
    fullyReordered[index],
  ];
  return fullyReordered.map((item, i) => ({ id: item.id, patch: { zIndex: i } }));
};

const readScrollWheelZoomEnabled = () => {
  try {
    return typeof window !== 'undefined'
      && window.localStorage?.getItem(SCROLL_WHEEL_ZOOM_KEY) === 'true';
  } catch { return false; }
};

const zoomViewportAt = (viewport, targetZoom, screenAnchor) => {
  const zoom = clamp(targetZoom, ZOOM_MIN, ZOOM_MAX);
  const worldX = (screenAnchor.x - viewport.x) / viewport.zoom;
  const worldY = (screenAnchor.y - viewport.y) / viewport.zoom;
  return {
    zoom,
    x: screenAnchor.x - worldX * zoom,
    y: screenAnchor.y - worldY * zoom,
  };
};

const fitViewportToItems = (items, width, height) => {
  if (items.length === 0) return { x: width / 2, y: height / 2, zoom: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  items.forEach((it) => {
    if (it.type === 'zone') {
      minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + it.w); maxY = Math.max(maxY, it.y + it.h);
    } else if (it.type === 'sticky' || it.type === 'image') {
      const iw = it.w || (it.type === 'sticky' ? STICKY_W : 200);
      const ih = it.h || (it.type === 'sticky' ? STICKY_H : 200);
      minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + iw); maxY = Math.max(maxY, it.y + ih);
    } else {
      minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + 200); maxY = Math.max(maxY, it.y + 60);
    }
  });
  const pad = 80;
  const contentWidth = (maxX - minX) + pad * 2;
  const contentHeight = (maxY - minY) + pad * 2;
  const zoom = clamp(Math.min(width / contentWidth, height / contentHeight), ZOOM_MIN, ZOOM_MAX);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    zoom,
    x: width / 2 - cx * zoom,
    y: height / 2 - cy * zoom,
  };
};

const hueFromId = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
};

const initialOf = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';

const fmtClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};

// Thin wrapper over window.storage with an in-memory fallback for dev/preview.
const memoryStore = new Map();
const storage = {
  async get(key, shared) {
    try {
      if (typeof window !== 'undefined' && window.storage?.get) {
        const r = await window.storage.get(key, shared);
        return r ?? null;
      }
    } catch { /* fall through to memory */ }
    const k = `${shared ? 's' : 'u'}::${key}`;
    return memoryStore.has(k) ? { value: memoryStore.get(k) } : null;
  },
  async set(key, value, shared) {
    try {
      if (typeof window !== 'undefined' && window.storage?.set) {
        await window.storage.set(key, value, shared);
        return;
      }
    } catch { /* fall through */ }
    const k = `${shared ? 's' : 'u'}::${key}`;
    memoryStore.set(k, value);
  },
  on(handler) {
    if (typeof window !== 'undefined' && typeof window.storage?.on === 'function') {
      window.storage.on(handler);
    }
  },
  off(handler) {
    if (typeof window !== 'undefined' && typeof window.storage?.off === 'function') {
      window.storage.off(handler);
    }
  },
  setLocalBusyItems(source, ids) {
    try { window.storage?.setLocalBusyItems?.(source, ids); } catch { /* noop fallback */ }
  },
  findRemoteBusyItem(ids) {
    try { return window.storage?.findRemoteBusyItem?.(ids) || null; } catch { return null; }
  },
  getRemoteBusyItems() {
    try { return window.storage?.getRemoteBusyItems?.() || new Map(); } catch { return new Map(); }
  },
  onBusyChange(handler) {
    try { return window.storage?.onBusyChange?.(handler) || (() => {}); } catch { return () => {}; }
  },
  offBusyChange(handler) {
    try { window.storage?.offBusyChange?.(handler); } catch { /* noop fallback */ }
  },
  // --- Granular board writes ---
  // Pass through to the Yjs bridge when present; otherwise mutate the in-memory
  // board so dev/preview (no relay) stays consistent. Each maps to one Yjs
  // transaction in the bridge; `opts.silent` keeps derived writes off undo.
  addItem(item, opts) {
    if (window.storage?.addItem) { window.storage.addItem(item, opts); return; }
    const b = memBoard(); memSetBoard({ ...b, items: [...b.items, item] });
  },
  addItems(items, opts) {
    if (window.storage?.addItems) { window.storage.addItems(items, opts); return; }
    const b = memBoard();
    const ids = new Set(b.items.map((it) => it.id));
    const additions = [];
    items.forEach((it) => {
      if (!it || !it.id || ids.has(it.id)) return;
      ids.add(it.id);
      additions.push(it);
    });
    memSetBoard({ ...b, items: [...b.items, ...additions] });
  },
  updateItem(id, patch, opts) {
    if (window.storage?.updateItem) { window.storage.updateItem(id, patch, opts); return; }
    const b = memBoard();
    memSetBoard({ ...b, items: b.items.map((it) => (it.id === id ? memMerge(it, patch) : it)) });
  },
  updateItems(entries, opts) {
    if (window.storage?.updateItems) { window.storage.updateItems(entries, opts); return; }
    const byId = new Map(entries.map((e) => [e.id, e.patch]));
    const b = memBoard();
    memSetBoard({ ...b, items: b.items.map((it) => (byId.has(it.id) ? memMerge(it, byId.get(it.id)) : it)) });
  },
  removeItem(id, opts) {
    if (window.storage?.removeItem) { window.storage.removeItem(id, opts); return; }
    const b = memBoard(); memSetBoard({ ...b, items: b.items.filter((it) => it.id !== id) });
  },
  setMeta(patch, opts) {
    if (window.storage?.setMeta) { window.storage.setMeta(patch, opts); return; }
    memSetBoard(memMerge(memBoard(), patch));
  },
  replaceBoard(board, opts) {
    if (window.storage?.replaceBoard) { window.storage.replaceBoard(board, opts); return; }
    memSetBoard(board);
  },
};

// In-memory board helpers for the dev/preview fallback (no Yjs relay).
const memBoard = () => {
  const k = 's::boardState';
  if (!memoryStore.has(k)) memoryStore.set(k, { ...DEFAULT_BOARD, items: [] });
  return memoryStore.get(k);
};
const memSetBoard = (next) => memoryStore.set('s::boardState', next);
// Merge a patch, treating an undefined value as "delete this key".
const memMerge = (obj, patch) => {
  const out = { ...obj };
  Object.entries(patch).forEach(([k, v]) => {
    if (v === undefined) delete out[k];
    else out[k] = v;
  });
  return out;
};

const centerOf = (it) => {
  if (it.type === 'zone') return { x: it.x + it.w / 2, y: it.y + it.h / 2 };
  if (it.type === 'sticky') {
    const w = it.w || STICKY_W;
    const h = it.h || STICKY_H;
    return { x: it.x + w / 2, y: it.y + h / 2 };
  }
  if (it.type === 'text') return { x: it.x + (it.w || TEXT_W) / 2, y: it.y + (it.h || TEXT_H) / 2 };
  if (it.type === 'image') return { x: it.x + (it.w || 200) / 2, y: it.y + (it.h || 200) / 2 };
  return { x: it.x, y: it.y };
};

const insideZone = (p, z) =>
  p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;

const isNestedIn = (z, ancestor, allItems) => {
  let current = z;
  const visited = new Set();
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const parent = effectiveOwnerZone(current, allItems);
    if (!parent) return false;
    if (parent.id === ancestor.id) return true;
    current = parent;
  }
  return false;
};

// Ids of every item that moves together with `zone` for drag/z-order: the zone
// itself, any persistently nested zone, and any sticky/image/text owned by the
// root zone or one of those nested zones.
const zoneGroupIds = (zone, allItems) => {
  const ids = new Set([zone.id]);
  const allZones = allItems.filter((i) => i.type === 'zone');
  allZones.forEach((z) => {
    if (z.id !== zone.id && isNestedIn(z, zone, allItems)) ids.add(z.id);
  });
  allItems.forEach((it) => {
    if (it.type === 'zone' || ids.has(it.id)) return;
    const owner = effectiveOwnerZone(it, allItems);
    if (owner && ids.has(owner.id)) ids.add(it.id);
  });
  return ids;
};

// Mirrors centerOf's per-type size defaults, so a dimensionless legacy item
// can't trivially satisfy resolveOwnerZone's strictly-larger guard below.
const effectiveArea = (it) => {
  if (it.type === 'zone') return it.w * it.h;
  const w = it.w || (it.type === 'sticky' ? STICKY_W : it.type === 'text' ? TEXT_W : it.type === 'image' ? 200 : 0);
  const h = it.h || (it.type === 'sticky' ? STICKY_H : it.type === 'text' ? TEXT_H : it.type === 'image' ? 200 : 0);
  return w * h;
};

// Pure geometric lookup, used only when writing a new persistent owner.
const resolveOwnerZone = (item, allItems) => {
  const c = centerOf(item);
  const area = effectiveArea(item);
  const candidates = allItems.filter((z) => (
    z.type === 'zone' && z.id !== item.id && z.w * z.h > area && insideZone(c, z)
  ));
  if (!candidates.length) return null;
  const minArea = Math.min(...candidates.map((z) => z.w * z.h));
  const tied = candidates.filter((z) => z.w * z.h === minArea);
  if (tied.length > 1) {
    const incumbent = tied.find((z) => z.id === item.parentZoneId);
    if (incumbent) return incumbent;
  }
  return tied[0];
};

// A persisted owner wins while it still covers the item. Explicit null means
// durably unzoned; only legacy items with no field fall back to geometry.
const effectiveOwnerZone = (item, allItems) => {
  if (Object.prototype.hasOwnProperty.call(item, 'parentZoneId')) {
    if (!item.parentZoneId) return null;
    const z = allItems.find((i) => i.id === item.parentZoneId && i.type === 'zone' && i.id !== item.id);
    return (z && insideZone(centerOf(item), z)) ? z : null;
  }
  return resolveOwnerZone(item, allItems);
};

// Nearest zone — the item's own owner, or the nearest ancestor via the
// ownership chain — that currently has an active voteTimer. Mutual exclusion
// at start time guarantees at most one zone in a chain is active at once.
const activeVoteZone = (item, allItems, atTime) => {
  let zone = effectiveOwnerZone(item, allItems);
  const visited = new Set();
  while (zone && !visited.has(zone.id)) {
    visited.add(zone.id);
    const timer = zone.voteTimer;
    if (timer && (!timer.endsAt || timer.endsAt > atTime)) return zone;
    zone = effectiveOwnerZone(zone, allItems);
  }
  return null;
};

// True if this zone, or any ancestor in its ownership chain, currently holds
// a voteTimer — presence-based (not endsAt-gated) so a deeper untimered
// descendant is still treated as "live" while its governing ancestor's
// session hasn't been finalized yet. Used to keep a stale "finished" badge
// from exposing a live in-progress tally anywhere beneath it, not just on
// the zone that stores the timer.
const zoneHasActiveGovernor = (zone, allItems) => {
  let z = zone;
  const visited = new Set();
  while (z && !visited.has(z.id)) {
    visited.add(z.id);
    if (z.voteTimer) return true;
    z = effectiveOwnerZone(z, allItems);
  }
  return false;
};

// A card's owner zone can hide/reveal its own private cards independently of
// the board-wide (now-legacy) allRevealed flag. A zone that has never had its
// own toggle clicked (revealed == null) inherits from the nearest ancestor
// zone that HAS an explicit value instead of jumping straight to the board
// default — so hiding a wrapper zone also hides a nested zone that hasn't
// set its own override, while a nested zone with its own explicit setting
// still keeps it (mirrors the ownership-chain walk activeVoteZone uses).
const effectiveRevealed = (item, allItems, boardAllRevealed) => {
  let zone = effectiveOwnerZone(item, allItems);
  const visited = new Set();
  while (zone && !visited.has(zone.id)) {
    if (zone.revealed != null) return zone.revealed;
    visited.add(zone.id);
    zone = effectiveOwnerZone(zone, allItems);
  }
  return boardAllRevealed;
};

// Shared by exportZoneCsv / exportBoardCsv.
const csvColorName = (i) => ['yellow', 'red', 'green', 'blue', 'purple', 'orange'][i] || String(i);
const csvEsc = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[\s]*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};

/* ============================================================
   Memoized item cards
   ------------------------------------------------------------
   Pulled out of RetroBoard.render so React.memo can skip items
   whose primitive props haven't changed. Crucial when a board
   has 100+ cards: viewport pan/zoom, voting, single-item drag,
   and selection changes no longer re-render every other card.
   ============================================================ */

const MEDAL_BY_RANK = { 1: '🥇', 2: '🥈', 3: '🥉' };

const StickyCard = React.memo(function StickyCard({
  item, selected, isEditing, isOwner, allRevealed, dense,
  voted, voteCount, voteFlash, voteRank, votingAllowedNow, showVoteCount, inZone,
  // `lang` is unused inside the body, but its presence as a prop
  // forces a re-render when language changes so t() picks up new strings.
  lang,
  onStartDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur, onToggleVote,
  editAreaRef,
}) {
  void lang;
  const it = item;
  const c = COLORS[it.color] || COLORS[0];
  const hideContent = it.private && !allRevealed && !isOwner;
  const w = it.w || STICKY_W;
  const h = it.h || STICKY_H;
  const rot = selected ? 0 : it.rotation;
  const top3 = voteRank != null;
  return (
    <div
      onMouseDown={(e) => { if (!isEditing) onStartDrag(e, it); }}
      onDoubleClick={(e) => { e.stopPropagation(); if (!hideContent) onBeginFocus(it, 'text'); }}
      style={{
        position: 'absolute',
        left: it.x,
        top: it.y,
        width: w,
        height: h,
        background: c.bg,
        border: `1.5px solid ${c.border}`,
        borderRadius: 4,
        padding: 12,
        boxSizing: 'border-box',
        transform: `rotate(${rot}deg)`,
        ['--rb-rot']: `${rot}deg`,
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        animation: top3 ? 'rb-glow 1.6s ease-in-out infinite, rb-appear-rot 0.28s ease-out' : 'rb-appear-rot 0.28s ease-out',
        // Drop the blurred shadow in dense mode — the 1.5px border still
        // separates cards, and overlapping blur is the main cluster paint cost.
        // The top3 result glow is kept (only ≤3 cards, meaningful highlight).
        boxShadow: top3
          ? `0 0 0 3px #fbbf24, 0 8px 24px rgba(251,191,36,0.6), 0 6px 14px rgba(0,0,0,0.12)`
          : (dense ? 'none' : '0 6px 14px rgba(0,0,0,0.12)'),
        cursor: 'grab',
        // Sarabun (Thai) leads so a Thai cluster's consonant + สระ + วรรณยุกต์
        // are shaped by one font — otherwise marks split to a fallback font and
        // detach. Sarabun also covers Latin, so mixed text stays consistent.
        fontFamily: '"Sarabun", "Plus Jakarta Sans", sans-serif',
        fontSize: it.fontSize || 15,
        lineHeight: 1.5,
        color: 'var(--text)',
        userSelect: 'none',
        outline: selected ? '2px solid #2563eb' : 'none',
        outlineOffset: 6,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Scope paint/layout to this sticky so a hover/vote on one card
        // doesn't trigger repaints of neighbours sharing the same layer.
        contain: 'layout paint style',
      }}
    >
      {it.private && !allRevealed && isOwner && (
        <div style={{ position: 'absolute', top: 6, right: 6, color: c.border }}>
          <Lock size={14} />
        </div>
      )}

      {top3 && (
        <div
          title={t('vote.rank', { n: voteRank })}
          style={{
            position: 'absolute', top: -10, left: -10, fontSize: 22,
            filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.35))',
            lineHeight: 1, pointerEvents: 'none',
          }}
        >
          {MEDAL_BY_RANK[voteRank]}
        </div>
      )}

      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          // Dense mode skips the GPU blur AND the text (the overlay obscures the
          // card); blur is only the obfuscation when text is actually rendered.
          filter: hideContent && !dense ? 'blur(8px)' : 'none',
          userSelect: hideContent ? 'none' : 'auto',
          color: it.fontColor || STICKY_AUTO_TEXT,
        }}
      >
        {(() => {
          if (isEditing) {
            return (
              <textarea
                ref={editAreaRef}
                value={it.text || ''}
                onChange={(e) => onTextChange(it.id, { text: e.target.value })}
                onKeyDown={(e) => onTextKeyDown(e)}
                onBlur={() => onTextBlur(it.id)}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder={t('sticky.placeholder')}
                style={{
                  width: '100%', height: '100%',
                  background: 'transparent', border: 'none', outline: 'none',
                  resize: 'none', fontFamily: 'inherit', fontSize: it.fontSize || 15,
                  lineHeight: 1.5, color: it.fontColor || STICKY_AUTO_TEXT,
                }}
              />
            );
          }
          // Don't render hidden text at all in dense mode (cheaper + no leak).
          if (hideContent && dense) return null;
          if (it.text) return it.text;
          return isOwner
            ? <span style={{ color: STICKY_AUTO_TEXT_FAINT, fontStyle: 'italic' }}>{t('sticky.placeholder')}</span>
            : '';
        })()}
      </div>

      {hideContent && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            background: 'rgba(255,255,255,0.35)',
            fontWeight: 600,
            color: c.border,
            gap: 6,
          }}
        >
          <Lock size={20} />
          <span style={{ fontSize: 13 }}>{t('sticky.hidden')}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('sticky.hiddenBy', { name: it.authorName })}</span>
        </div>
      )}

      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 4, fontSize: 11, color: 'var(--text-muted)',
        }}
      >
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>
          {it.authorName || 'Anon'}
        </span>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if (!hideContent) onToggleVote(it); }}
            disabled={hideContent || (!votingAllowedNow && !voted)}
            style={{
              display: 'inline-flex', alignItems: 'center',
              gap: votingAllowedNow ? 10 : 4,
              background: voted ? c.border : 'rgba(0,0,0,0.06)',
              color: voted ? '#fff' : '#374151',
              border: 'none', borderRadius: 999,
              padding: votingAllowedNow ? '8px 25px' : '3px 10px',
              fontSize: votingAllowedNow ? 30 : 12,
              fontWeight: 600,
              cursor: (hideContent || !votingAllowedNow) ? 'not-allowed' : 'pointer',
              opacity: hideContent ? 0.4 : (votingAllowedNow ? 1 : 0.6),
              transition: 'background 0.15s, color 0.15s, padding 0.2s, font-size 0.2s',
            }}
            title={
              hideContent ? t('sticky.hideContent')
              : !inZone ? t('vote.noZone')
              : !votingAllowedNow ? t('vote.notStartedYet')
              : voted ? t('vote.tooltip.unvote') : t('vote.tooltip.vote')
            }
          >
            <ThumbsUp size={votingAllowedNow ? 30 : 12} />
            {showVoteCount && (
              <span
                key={voteCount}
                style={{ display: 'inline-block', animation: 'rb-bump 0.35s ease', transformOrigin: 'center' }}
              >
                {voteCount}
              </span>
            )}
          </button>
          {voteFlash && (
            <span
              key={voteFlash}
              style={{
                position: 'absolute',
                left: '50%',
                bottom: '110%',
                pointerEvents: 'none',
                color: c.border,
                fontSize: 18,
                fontWeight: 800,
                textShadow: '0 1px 2px rgba(0,0,0,0.2)',
                animation: 'rb-vote-float 0.9s ease-out forwards',
              }}
            >+1
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

const ZoneCard = React.memo(function ZoneCard({
  item, selected, isEditingTitle, childCount, lang,
  onStartZoneDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur,
  editAreaRef,
}) {
  void lang;
  const it = item;
  const c = COLORS[it.color] || COLORS[0];
  const titleFs = it.fontSize || 16;
  const titleH = Math.max(ZONE_TITLE_H, titleFs + 18);
  return (
    <div
      style={{
        position: 'absolute',
        left: it.x,
        top: it.y,
        width: it.w,
        height: it.h,
        background: c.zoneBg,
        border: `2px solid ${c.border}`,
        // Square top corners — the title bar's curved top corners cover the
        // outer shape, and a rounded zone-box top would carve a visible notch
        // out of the seam where they meet.
        borderRadius: '0 0 12px 12px',
        boxSizing: 'border-box',
        outline: selected ? '2px solid #2563eb' : 'none',
        outlineOffset: 6,
        pointerEvents: 'none',
        animation: 'rb-appear 0.28s ease-out',
      }}
    >
      <div
        onMouseDown={(e) => { if (!isEditingTitle) onStartZoneDrag(e, it); }}
        onDoubleClick={(e) => { e.stopPropagation(); onBeginFocus(it, 'title'); }}
        style={{
          position: 'absolute',
          // Extend 2px beyond the parent's padding edge on each side to cover
          // the zone's 2px border line — without this offset the title bar
          // looks inset and leaves a visible step at the corners.
          top: -titleH,
          left: -2,
          right: -2,
          height: titleH,
          background: c.border,
          color: '#fff',
          // Outer corner radius matches the zone box (12px) so the rounded
          // top of the assembly looks like a single continuous shape.
          borderRadius: '12px 12px 0 0',
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          gap: 8,
          cursor: isEditingTitle ? 'text' : (it.locked ? 'not-allowed' : 'grab'),
          fontWeight: 600,
          fontSize: titleFs,
          userSelect: 'none',
          boxShadow: '0 -1px 4px rgba(0,0,0,0.08)',
          pointerEvents: 'auto',
        }}
      >
        {isEditingTitle ? (
          <input
            ref={editAreaRef}
            value={it.title || ''}
            onChange={(e) => onTextChange(it.id, { title: e.target.value })}
            onKeyDown={(e) => onTextKeyDown(e, { singleLine: true })}
            onBlur={() => onTextBlur(it.id)}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              flex: 1, background: 'rgba(255,255,255,0.25)',
              border: 'none', outline: 'none', color: '#fff',
              fontSize: titleFs, fontWeight: 600,
            }}
          />
        ) : (
          <>
            {it.locked && <Lock size={13} />}
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {it.title}
            </span>
            <span
              style={{
                background: 'rgba(255,255,255,0.25)',
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {childCount}
            </span>
          </>
        )}
      </div>
      <div data-surface="1" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
    </div>
  );
});

const TextCard = React.memo(function TextCard({
  item, selected, isEditing, lang,
  onStartDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur,
  editAreaRef,
}) {
  void lang;
  const it = item;
  return (
    <div
      onMouseDown={(e) => { if (!isEditing) onStartDrag(e, it); }}
      onDoubleClick={(e) => { e.stopPropagation(); onBeginFocus(it, 'text'); }}
      style={{
        position: 'absolute',
        left: it.x,
        top: it.y,
        fontFamily: '"Caveat", "Sarabun", cursive',
        fontSize: it.fontSize || 40,
        color: it.fontColor || 'var(--text)',
        cursor: isEditing ? 'text' : 'grab',
        userSelect: 'none',
        padding: '4px 8px',
        width: it.w || TEXT_W,
        height: it.h || TEXT_H,
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        outline: selected ? '2px dashed #2563eb' : 'none',
        outlineOffset: 6,
        borderRadius: 6,
        animation: 'rb-appear 0.28s ease-out',
      }}
    >
      {isEditing ? (
        <textarea
          ref={editAreaRef}
          value={it.text || ''}
          onChange={(e) => onTextChange(it.id, { text: e.target.value })}
          onKeyDown={(e) => onTextKeyDown(e)}
          onBlur={() => onTextBlur(it.id)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: '100%', height: '100%',
            background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', fontFamily: 'inherit', fontSize: it.fontSize || 40,
            color: it.fontColor || 'var(--text)',
          }}
        />
      ) : it.text}
    </div>
  );
});

const ImageCard = React.memo(function ImageCard({ item, selected, dense, onStartDrag }) {
  const it = item;
  const w = it.w || 200;
  const h = it.h || 200;
  return (
    <div
      onMouseDown={(e) => onStartDrag(e, it)}
      style={{
        position: 'absolute',
        left: it.x,
        top: it.y,
        width: w,
        height: h,
        // drop-shadow respects PNG alpha but is GPU-expensive; a tight blur
        // radius keeps it cheap when many images are on screen, and dense mode
        // drops it entirely. CSS containment scopes layout/paint invalidation
        // to this card so a change in one image doesn't repaint neighbours.
        filter: dense ? 'none' : 'drop-shadow(0 3px 6px rgba(0,0,0,0.18))',
        outline: selected ? '2px solid #2563eb' : 'none',
        outlineOffset: 6,
        cursor: 'grab',
        userSelect: 'none',
        animation: 'rb-appear 0.28s ease-out',
        contain: 'layout paint style',
      }}
    >
      <img
        src={it.src}
        alt=""
        draggable={false}
        loading="lazy"
        decoding="async"
        style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
      />
    </div>
  );
});

/* ============================================================
   Image upload prep (shared by paste/drop and legacy-import sanitization)
   ============================================================ */

// Decode a blob, downscale to IMAGE_MAX_DIM if needed, and re-encode to fit
// IMAGE_MAX_BYTES if the resize round-trip pushed it back over. Caller is
// expected to have already checked type/original size. Returns null if no
// re-encode gets it under the cap.
const prepareImageBlob = async (blob) => {
  // Decode via an object URL (not a base64 data URL) — images are uploaded
  // to the server as raw bytes now, so there's no reason to pay for base64
  // encoding just to read dimensions / draw into a resize canvas.
  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  let finalBlob = blob;
  let nw = img.naturalWidth;
  let nh = img.naturalHeight;
  const maxEdge = Math.max(nw, nh);
  if (maxEdge > IMAGE_MAX_DIM) {
    const r = IMAGE_MAX_DIM / maxEdge;
    const cw = Math.round(nw * r);
    const ch = Math.round(nh * r);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, cw, ch);
    // JPEG keeps size down; PNG keeps transparency.
    const isTransparent = blob.type.includes('png') || blob.type.includes('gif') || blob.type.includes('webp');
    finalBlob = await new Promise((res) => canvas.toBlob(res, isTransparent ? 'image/png' : 'image/jpeg', 0.85));
    nw = cw;
    nh = ch;
  }
  // Belt-and-suspenders payload cap. The original blob.size check rejects
  // huge originals, but a lossless PNG re-encode of a transparent image can
  // balloon past it — cap what actually gets uploaded and stored server-side.
  if (!finalBlob || finalBlob.size > IMAGE_MAX_BYTES) {
    // Try re-encoding as JPEG first (drops transparency but saves ~60%).
    const canvas = document.createElement('canvas');
    canvas.width = nw;
    canvas.height = nh;
    canvas.getContext('2d').drawImage(img, 0, 0, nw, nh);
    const jpeg = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
    if (jpeg && jpeg.size <= IMAGE_MAX_BYTES) {
      finalBlob = jpeg;
    } else {
      return null;
    }
  }
  return { blob: finalBlob, nw, nh };
};

// Decode manually instead of fetch(dataUrl) — the page's CSP connect-src
// doesn't list `data:`, so fetch() of a data URL is blocked in production.
const dataUrlToBlob = (dataUrl) => {
  const commaIdx = dataUrl.indexOf(',');
  const header = dataUrl.slice('data:'.length, commaIdx);
  const isBase64 = header.endsWith(';base64');
  const mime = (isBase64 ? header.slice(0, -';base64'.length) : header) || 'application/octet-stream';
  const data = dataUrl.slice(commaIdx + 1);
  const binary = isBase64 ? atob(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

// Server 429s ("image upload failed: 429") when the per-IP upload bucket is
// exhausted — re-uploading many legacy images back to back can hit this.
// Any other failure (bad format, network) won't fix itself on retry.
const uploadWithRetry = async (blob, attempts = 6) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await window.storage.uploadImage(blob);
    } catch (err) {
      if (i === attempts - 1 || !/: 429$/.test(err.message)) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => { setTimeout(res, 1100); });
    }
  }
  return null; // unreachable — loop always returns or throws
};

// Legacy exports (from before server-hosted image storage) embed images as
// base64 data URLs directly on the item. Writing those into Yjs as-is can
// produce a single transaction bigger than the yjs-server WS frame cap —
// the server silently refuses the oversized frame, so the import never
// reaches persistence or any other peer while the importer's own optimistic
// state still shows it (a split-brain). Re-upload each one through the
// normal image pipeline so it shrinks back to a short URL before it's ever
// written to the board.
const sanitizeImportedImages = async (items) => {
  let skipped = 0;
  const out = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const item of items) {
    if (item.type !== 'image' || typeof item.src !== 'string' || !item.src.startsWith('data:')) {
      out.push(item);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const rawBlob = await dataUrlToBlob(item.src);
      const prepared = rawBlob.size > IMAGE_MAX_BYTES || !UPLOADABLE_IMAGE_TYPES.has(rawBlob.type)
        ? null
        // eslint-disable-next-line no-await-in-loop
        : await prepareImageBlob(rawBlob);
      if (!prepared) { skipped += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      const url = await uploadWithRetry(prepared.blob);
      out.push({ ...item, src: url, natW: prepared.nw, natH: prepared.nh });
    } catch {
      skipped += 1;
    }
  }
  return { items: out, skipped };
};

/* ============================================================
   Component
   ============================================================ */

export default function RetroBoard({ boardCode = null, boardToken = null }) {
  /* ---------- i18n + theme ---------- */
  const [lang, setLang] = useLang();
  const { pref: themePref, setThemePref } = useTheme();
  // `lang` is referenced so React re-renders strings on toggle.
  void lang;

  /* ---------- Identity ---------- */
  const {
    userId, userIdRef, userName,
    nameDraft, setNameDraft,
    nameModalOpen, setNameModalOpen,
    hydrate: hydrateIdentity, saveName,
  } = useUserIdentity(storage);

  /* ---------- Board (shared) ---------- */
  const [board, setBoard] = useState(DEFAULT_BOARD);
  const boardRef = useRef(board);
  useEffect(() => { boardRef.current = board; }, [board]);

  /* ---------- Viewport (per-user) ---------- */
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const viewportRef = useRef(viewport);
  useEffect(() => {
    if (interactionRef.current === null) viewportRef.current = viewport;
  }, [viewport]);
  const [scrollWheelZoomEnabled, setScrollWheelZoomEnabled] = useState(readScrollWheelZoomEnabled);
  const scrollWheelZoomEnabledRef = useRef(scrollWheelZoomEnabled);
  useEffect(() => { scrollWheelZoomEnabledRef.current = scrollWheelZoomEnabled; }, [scrollWheelZoomEnabled]);
  const toggleScrollWheelZoom = useCallback(() => {
    const next = !scrollWheelZoomEnabledRef.current;
    scrollWheelZoomEnabledRef.current = next;
    setScrollWheelZoomEnabled(next);
    try { window.localStorage.setItem(SCROLL_WHEEL_ZOOM_KEY, String(next)); } catch { /* noop */ }
  }, []);

  /* ---------- Presence (shared map) ---------- */
  const [presence, setPresence] = useState({});

  /* ---------- UI state ---------- */
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Mirror selectedIds in a ref so drag callbacks don't need to depend on it.
  // Without this, every click that flips selection would invalidate
  // startItemDrag → invalidate renderedItems → re-build every card's JSX.
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const [focusedTextId, setFocusedTextId] = useState(null);
  const [marquee, setMarquee] = useState(null); // {x1,y1,x2,y2} in screen coords
  // Vote state lives in Yjs as per-user-per-item keys (CRDT — no LWW race).
  // `votesByItem` mirrors window.storage.snapshotVotes() and re-renders on remote change.
  const [votesByItem, setVotesByItem] = useState(() => (
    typeof window !== 'undefined' && window.storage?.snapshotVotes
      ? window.storage.snapshotVotes()
      : new Map()
  ));
  const [creationMode, setCreationMode] = useState(null); // 'zone' | 'select' | null
  const clipboardRef = useRef(null);
  const [zonePreview, setZonePreview] = useState(null); // {x,y,w,h} in world coords
  const creationModeRef = useRef(null);
  useEffect(() => { creationModeRef.current = creationMode; }, [creationMode]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [timerSetupOpen, setTimerSetupOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [playerListOpen, setPlayerListOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [fontColorOpen, setFontColorOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [customTemplates, setCustomTemplates] = useState([]);
  const [toast, setToastRaw] = useState(null);
  const setToast = useCallback((next) => {
    setToastRaw(next ? { ...next, t: Date.now() } : null);
  }, []);
  const [voteFlashes, setVoteFlashes] = useState({}); // itemId -> timestamp of latest local vote
  const flashVote = useCallback((itemId) => {
    const t = Date.now();
    setVoteFlashes((prev) => ({ ...prev, [itemId]: t }));
    setTimeout(() => {
      setVoteFlashes((prev) => {
        if (prev[itemId] !== t) return prev;
        const { [itemId]: _gone, ...rest } = prev;
        return rest;
      });
    }, 900);
  }, []);
  const [now, setNow] = useState(Date.now());
  const [loaded, setLoaded] = useState(false);
  const [confirmResetVotes, setConfirmResetVotes] = useState(false);
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false });

  const focusedTextIdRef = useRef(null);
  const updateFocusedText = useCallback((next) => {
    focusedTextIdRef.current = next;
    setFocusedTextId(next);
    const itemId = typeof next === 'string' ? next.split(':')[0] : null;
    storage.setLocalBusyItems('text', itemId ? [itemId] : []);
  }, []);

  // Hold Space + drag = pan the canvas regardless of what's under the cursor
  // (Figma/Miro-style), overriding the normal "drag a card moves it" or
  // "drag empty canvas pans" behavior. Ignored while typing in a text field
  // so a literal space keystroke isn't swallowed. Consumed in
  // onCanvasMouseDown/startItemDrag/startZoneDrag below.
  const spaceHeldRef = useRef(false);
  useEffect(() => {
    const isTypingTarget = () => {
      const tag = document.activeElement?.tagName;
      return tag === 'TEXTAREA' || tag === 'INPUT';
    };
    const onSpaceKeyDown = (e) => {
      if (e.code !== 'Space' || isTypingTarget()) return;
      e.preventDefault();
      if (spaceHeldRef.current) return;
      spaceHeldRef.current = true;
      if (canvasRef.current) {
        canvasRef.current.style.cursor = interactionRef.current?.kind === 'pan' ? 'grabbing' : 'grab';
      }
    };
    const onSpaceKeyUp = (e) => {
      if (e.code !== 'Space') return;
      spaceHeldRef.current = false;
      if (canvasRef.current) {
        canvasRef.current.style.cursor = interactionRef.current?.kind === 'pan' ? 'grabbing' : '';
      }
    };
    // If the window loses focus while Space is held (e.g. alt-tab), the
    // keyup never arrives — reset here so pan mode doesn't get stuck on.
    const onBlur = () => {
      spaceHeldRef.current = false;
      if (canvasRef.current) {
        canvasRef.current.style.cursor = interactionRef.current?.kind === 'pan' ? 'grabbing' : '';
      }
    };
    window.addEventListener('keydown', onSpaceKeyDown);
    window.addEventListener('keyup', onSpaceKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onSpaceKeyDown);
      window.removeEventListener('keyup', onSpaceKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // single-select helpers
  const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const setSelectedId = useCallback((id) => {
    setSelectedIds(id == null ? new Set() : new Set([id]));
  }, []);

  /* ---------- Refs ---------- */
  const canvasRef = useRef(null);
  // Imperative refs for the transformed world layer and the grid background.
  // Pan updates these directly to skip React's render cycle entirely while
  // dragging — see startPan/applyViewportToDom below.
  const worldRef = useRef(null);
  const gridRef = useRef(null);
  const saveTimerRef = useRef(null);
  const interactionRef = useRef(null);
  const editAreaRef = useRef(null);
  // Ids of items currently being dragged/resized locally — protected from remote overwrite of geometry.
  const dragItemsRef = useRef(null);
  const activeGeometryFinalizerRef = useRef(null);
  const activeViewportFinalizerRef = useRef(null);
  useEffect(() => () => {
    activeGeometryFinalizerRef.current?.();
    activeViewportFinalizerRef.current?.();
    storage.setLocalBusyItems('geometry', []);
    storage.setLocalBusyItems('text', []);
  }, []);

  /* ---------- Derived ---------- */
  const onlineUsers = useMemo(() => {
    const t = now;
    return Object.values(presence).filter((p) => t - (p.lastSeen || 0) < ONLINE_WINDOW);
  }, [presence, now]);

  const sortedItems = useMemo(() => {
    return [...board.items].sort(compareZOrder);
  }, [board.items]);

  // Switch cards to cheap paint (no blurred shadow/filter) once the board holds
  // many cards. Keyed on total count — not visible count or zoom — so it never
  // flaps during pan/zoom and doesn't pull viewport into the render memo.
  const denseRender = useMemo(
    () => board.items.reduce(
      (n, it) => (it.type === 'sticky' || it.type === 'image' ? n + 1 : n),
      0,
    ) >= DENSE_CARD_THRESHOLD,
    [board.items],
  );

  // Viewport size — tracked so we can cull off-screen items at render time.
  // Initialised lazily to handle SSR-style first paint with no window.
  const [viewportSize, setViewportSize] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  useEffect(() => {
    const onResize = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Snapped viewport — quantize pan/zoom so small movements don't invalidate
  // the visibleItems memo. The actual transform still uses the live viewport;
  // this only stabilises the culling decision.
  const cullViewport = useMemo(() => ({
    x: Math.floor(viewport.x / 200) * 200,
    y: Math.floor(viewport.y / 200) * 200,
    zoom: Math.round(viewport.zoom * 20) / 20,
  }), [viewport]);

  // Only render items whose AABB intersects the visible world rect (with a
  // generous margin so items don't pop in at the edge during pan/zoom). The
  // margin is wider than the snap step so culling lines never bite.
  const visibleItems = useMemo(() => {
    const z = cullViewport.zoom;
    const wx0 = -cullViewport.x / z;
    const wy0 = -cullViewport.y / z;
    const wx1 = (viewportSize.w - cullViewport.x) / z;
    const wy1 = (viewportSize.h - cullViewport.y) / z;
    const margin = 600 / z;
    return sortedItems.filter((it) => {
      const iw = it.w || (it.type === 'sticky' ? STICKY_W : it.type === 'text' ? TEXT_W : 200);
      const ih = it.h || (it.type === 'sticky' ? STICKY_H : it.type === 'text' ? TEXT_H : 200);
      // Zones host a title bar that hangs above their box — extend the AABB
      // upward by a conservative title height so the bar isn't clipped first.
      const topPad = it.type === 'zone' ? Math.max(ZONE_TITLE_H, (it.fontSize || 14) + 18) : 0;
      return it.x + iw >= wx0 - margin
        && it.x <= wx1 + margin
        && it.y + ih >= wy0 - margin
        && it.y - topPad <= wy1 + margin;
    });
  }, [sortedItems, cullViewport, viewportSize]);

  // Single O(n*z) pass instead of O(n) per zone on every render. Counts stickies
  // by their effective owner zone, keyed by zone id.
  const zoneChildCount = useMemo(() => {
    const counts = new Map();
    const zones = board.items.filter((i) => i.type === 'zone');
    zones.forEach((z) => counts.set(z.id, 0));
    board.items.forEach((it) => {
      if (it.type !== 'sticky') return;
      const owner = effectiveOwnerZone(it, board.items);
      if (owner) counts.set(owner.id, (counts.get(owner.id) || 0) + 1);
    });
    return counts;
  }, [board.items]);

  // Vote derivation helpers — read from the CRDT-backed per-user keys.
  const voteCountOf = useCallback((id) => votesByItem.get(id)?.size ?? 0, [votesByItem]);
  const didUserVoteOn = useCallback((id) => !!votesByItem.get(id)?.has(userId), [votesByItem, userId]);

  // Map of stickyId -> rank (1, 2, or 3) among its own zone's votes, once
  // that zone's results are finalized — drives both the top3 glow and the
  // medal badge (🥇🥈🥉). Rank is per-zone, not board-wide: each zone in a
  // finished vote group gets its own #1/#2/#3.
  const topVotedRanks = useMemo(() => {
    const finishedRoots = board.items.filter((i) => i.type === 'zone' && i.lastResultsAt && !i.voteTimer);
    const stickies = board.items.filter((i) => i.type === 'sticky');
    const result = new Map();
    finishedRoots.forEach((root) => {
      const groupZoneIds = [...zoneGroupIds(root, board.items)]
        .filter((id) => {
          const zone = board.items.find((i) => i.id === id);
          // Never expose a live in-progress tally through an ancestor's stale
          // finished-results badge — including a deeper untimered
          // descendant governed by a timer further up its own chain.
          return zone?.type === 'zone' && !zoneHasActiveGovernor(zone, board.items);
        });
      groupZoneIds.forEach((zoneId) => {
        const owned = stickies
          .filter((s) => effectiveOwnerZone(s, board.items)?.id === zoneId)
          .filter((s) => voteCountOf(s.id) > 0)
          .sort((a, b) => voteCountOf(b.id) - voteCountOf(a.id))
          .slice(0, 3);
        owned.forEach((s, idx) => result.set(s.id, idx + 1));
      });
    });
    return result;
  }, [board, voteCountOf]);

  /* ============================================================
     Load identity + initial board
     ============================================================ */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uRec = await storage.get('userId', false);
      let id = uRec?.value;
      if (!id) {
        id = uid();
        await storage.set('userId', id, false);
      }
      const nRec = await storage.get('userName', false);
      const name = nRec?.value || '';

      const vRec = await storage.get('viewport', false);
      const vp = vRec?.value || { x: 0, y: 0, zoom: 1 };

      const bRec = await storage.get('boardState', true);
      const bs = bRec?.value || DEFAULT_BOARD;

      const pRec = await storage.get('presence', true);
      const pmap = pRec?.value || {};
      const tRec = await storage.get('customTemplates', true);
      const tpls = tRec?.value || [];

      if (cancelled) return;
      hydrateIdentity(id, name);
      setViewport(vp);
      setBoard({ ...DEFAULT_BOARD, ...bs });
      setPresence(pmap);
      setCustomTemplates(tpls);
      setLoaded(true);

      // No initial-load admin claim here. The race was: storage.get returns
      // the boardState snapshot at the moment of read, which can be stale
      // (sync still in flight). synced() might flip to true an instant
      // later, and the stale `bs.adminUserId === undefined` then triggers
      // a claim that overwrites whatever the server actually has — every
      // returning client becomes "admin" in their own view. Deferring the
      // entire decision to the heartbeat tick is correct: it reads the
      // live adminUserId from yMeta via storage.getAdminUserId() and is
      // also triggered immediately after sync via storage.onSynced.
      // Auto-open templates if empty
      if ((bs.items?.length || 0) === 0) setTemplatesOpen(true);
    })();
    return () => { cancelled = true; };
  }, []);

  /* ============================================================
     Granular board writes.
     Each helper does an optimistic setBoard (instant UI) and writes only the
     delta to Yjs — so a keystroke or a drag frame no longer re-diffs the whole
     board. `opts.silent` maps to a 'system'-origin Yjs write that peers receive
     but the local undo stack ignores (for derived/automatic changes).
     ============================================================ */
  const lastFlushRef = useRef(0);
  // Latest geometry entries pending a throttled flush during a drag/resize.
  const pendingGeomRef = useRef(null);
  // itemId -> { x, y, w, h, until } for drags that just ended. Lets
  // applyRemoteBoard keep preserving local geometry for a grace period past
  // mouseup, not just while dragItemsRef marks an active drag.
  const recentlyMovedRef = useRef(new Map());

  // ---- One-item field patch ----
  const updateItem = useCallback((id, patch, opts) => {
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    }));
    storage.updateItem(id, patch, opts);
  }, []);

  // ---- Add one / many new items ----
  const addItemLocal = useCallback((item) => {
    setBoard((prev) => ({ ...prev, items: [...prev.items, item] }));
    storage.addItem(item);
  }, []);

  const addItemsLocal = useCallback((items) => {
    if (!items.length) return;
    setBoard((prev) => ({ ...prev, items: [...prev.items, ...items] }));
    storage.addItems(items);
  }, []);

  // ---- Board-level meta patch ----
  const patchMeta = useCallback((patch, opts) => {
    setBoard((prev) => ({ ...prev, ...patch }));
    storage.setMeta(patch, opts);
  }, []);

  const {
    isAdmin, canClaim, pinPromptCfg, requireAdminPin, adminClaim, adminTransfer,
  } = useAdminRole({
    userId, userName, board, boardRef, onlineUsers, presence,
    boardCode, boardToken, patchMeta, setToast, storage,
  });

  // ---- Full board replace (import / clear) ----
  const replaceBoardLocal = useCallback((nextBoard, opts) => {
    setBoard(nextBoard);
    storage.replaceBoard(nextBoard, opts);
  }, []);

  /* ----- Throttled geometry writer for drag / resize -----
     Optimistic setBoard runs every frame for a live local feel; the granular
     Yjs write is throttled to DRAG_FLUSH_MS with a DRAG_TRAILING_MS trailing
     flush. `pendingGeomRef` always holds the freshest entries, so timing
     against React's commit cycle is irrelevant. */
  const flushPendingGeom = useCallback(() => {
    const entries = pendingGeomRef.current;
    if (entries && entries.length) storage.updateItems(entries);
    lastFlushRef.current = Date.now();
  }, []);

  const commitGeometry = useCallback((entries) => {
    // Single enforcement point for "locked zones don't move" — every drag/
    // resize path (solo, group, zone-carries-children) funnels through here,
    // so filtering here also covers a locked zone caught in someone else's
    // multi-select drag, not just its own title bar / resize handles.
    const filtered = entries.filter((e) => {
      const it = boardRef.current.items.find((i) => i.id === e.id);
      return !(it?.type === 'zone' && it.locked);
    });
    if (!filtered.length) return;
    const byId = new Map(filtered.map((e) => [e.id, e.patch]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (byId.has(it.id) ? { ...it, ...byId.get(it.id) } : it)),
    }));
    pendingGeomRef.current = filtered;
    if (Date.now() - lastFlushRef.current >= DRAG_FLUSH_MS) flushPendingGeom();
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPendingGeom, DRAG_TRAILING_MS);
  }, [flushPendingGeom]);

  const endGeometry = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const entries = pendingGeomRef.current;
    if (entries && entries.length) {
      const until = Date.now() + RECENT_MOVE_WINDOW_MS;
      entries.forEach((e) => recentlyMovedRef.current.set(e.id, { ...e.patch, until }));
    }
    flushPendingGeom();
    pendingGeomRef.current = null;
  }, [flushPendingGeom]);

  const discardPendingGeometry = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    pendingGeomRef.current = null;
  }, []);

  /* ============================================================
     Realtime push: subscribe to storage change events.
     Polling kept as a long-interval safety net only.
     ============================================================ */
  const applyRemoteBoard = useCallback((remote, isUndoRedo) => {
    if (!remote) return;
    // Undo/redo is a deliberate, authoritative correction — never let the
    // "protect a just-finished local drag from a stale peer echo" grace
    // window (recentlyMovedRef, below) mask it back to the pre-undo
    // position. Without this, undoing a drag reverts the Yjs doc correctly
    // but the on-screen sticky stays put until a refresh clears the ref.
    if (isUndoRedo) recentlyMovedRef.current.clear();
    const focusedItemId = focusedTextIdRef.current?.split(':')[0] || null;
    if (focusedItemId && !remote.items?.some((it) => it.id === focusedItemId)) {
      const localFocused = boardRef.current.items.find((it) => it.id === focusedItemId);
      // A "recent local create" is normally preserved against a stale peer
      // echo that just hasn't caught up yet — but an undo/redo removing the
      // item IS the authoritative state, not staleness, so it must win even
      // if the create happened moments ago.
      const isRecentLocalCreate = !isUndoRedo && localFocused
        && localFocused.authorId === userIdRef.current
        && (localFocused.createdAt || 0) > Date.now() - 8000;
      if (!isRecentLocalCreate) updateFocusedText(null);
    }
    setBoard((prev) => {
      const next = { ...DEFAULT_BOARD, ...remote };
      const fid = focusedTextIdRef.current;
      const dragIds = dragItemsRef.current; // Set<id> or null
      const focusedItemId = fid ? fid.split(':')[0] : null;
      const focusedField = fid ? fid.split(':')[1] : null;
      const remoteIds = new Set(next.items.map((i) => i.id));
      // Prune expired entries so a stale grace-period record can't outlive
      // its window and mask a genuine later remote change to the same item.
      const recentlyMoved = recentlyMovedRef.current;
      const nowMs = Date.now();
      recentlyMoved.forEach((v, id) => { if (v.until <= nowMs) recentlyMoved.delete(id); });
      if (focusedItemId || (dragIds && dragIds.size > 0) || recentlyMoved.size > 0) {
        // Index prev items by id once (O(N)) so the merge below is O(N), not the
        // O(N²) a per-item find() would cost during live collaboration.
        const prevById = new Map(prev.items.map((p) => [p.id, p]));
        next.items = next.items.map((i) => {
          const localItem = prevById.get(i.id);
          if (!localItem) return i;
          let patched = i;
          if (focusedItemId === i.id && focusedField) {
            patched = { ...patched, [focusedField]: localItem[focusedField] };
          }
          if (dragIds && dragIds.has(i.id)) {
            // preserve local geometry mid-drag
            patched = { ...patched, x: localItem.x, y: localItem.y };
            if (localItem.w != null) patched.w = localItem.w;
            if (localItem.h != null) patched.h = localItem.h;
          } else if (recentlyMoved.has(i.id)) {
            // preserve local geometry for a short grace period after a drag
            // just ended — a concurrent peer write (e.g. the vote-finalize
            // auto-sort) can otherwise land on the same item and win the
            // Yjs conflict resolution despite happening earlier in real
            // time (see RECENT_MOVE_WINDOW_MS).
            const rm = recentlyMoved.get(i.id);
            patched = { ...patched, x: rm.x, y: rm.y };
            if (rm.w != null) patched.w = rm.w;
            if (rm.h != null) patched.h = rm.h;
          }
          return patched;
        });
      }
      // Preserve local-only items that the remote snapshot doesn't know about
      // yet. Without this, a peer echo arriving in the gap between a local
      // create and its WS flush silently strips the new item from React state.
      // Only items WE just authored within the last few seconds qualify — older
      // missing items are genuine peer-deletes that must be honored. An
      // undo/redo removing the item is likewise authoritative, not a stale
      // echo, so it's never re-added here either.
      const RECENT_AUTHOR_WINDOW_MS = 8000;
      const cutoff = Date.now() - RECENT_AUTHOR_WINDOW_MS;
      const localOnly = isUndoRedo ? [] : prev.items.filter((p) => (
        !remoteIds.has(p.id)
        && p.authorId === userIdRef.current
        && (p.createdAt || 0) > cutoff
      ));
      if (localOnly.length) next.items = [...next.items, ...localOnly];
      return next;
    });
  }, [updateFocusedText]);

  useEffect(() => {
    if (!loaded) return undefined;
    const handler = (e) => {
      const { scope, key, value, isUndoRedo } = e.detail || {};
      if (scope !== 's') return;
      // applyRemoteBoard preserves geometry for items in dragItemsRef and
      // text fields for the currently focused textarea, so we can apply
      // remote updates live even while the user drags.
      if (key === 'boardState') applyRemoteBoard(value, isUndoRedo);
      else if (key === 'presence') setPresence(value || {});
      else if (key === 'customTemplates') setCustomTemplates(value || []);
    };
    if (typeof storage.on === 'function') storage.on(handler);
    // If Yjs sync completed BETWEEN the initial bRec read above and this
    // handler registration, the resulting change event fired into the void.
    // Re-read once now to catch up — and additionally re-read every time the
    // WebSocket re-syncs (reconnect, etc.) so React state never drifts from
    // the canonical yMeta/yItems.
    // Subscribe to vote-key changes (local + remote) and rebuild the snapshot.
    const voteHandler = () => {
      if (typeof window !== 'undefined' && window.storage?.snapshotVotes) {
        setVotesByItem(window.storage.snapshotVotes());
      }
    };
    const resync = () => {
      storage.get('boardState', true).then((r) => {
        if (r?.value) applyRemoteBoard(r.value);
      });
      storage.get('presence', true).then((r) => {
        if (r?.value) setPresence(r.value);
      });
      // Custom templates can flicker to empty if the initial cold read landed
      // before Yjs sync and the change handler wasn't subscribed yet.
      storage.get('customTemplates', true).then((r) => {
        if (Array.isArray(r?.value)) setCustomTemplates(r.value);
      });
      voteHandler();
    };
    resync();
    const offSyncRefresh = window.storage?.onSynced?.(resync) || (() => {});
    let stopped = false;
    const safetyTick = async () => {
      if (stopped) return;
      const bRec = await storage.get('boardState', true);
      if (bRec?.value) applyRemoteBoard(bRec.value);
      const pRec = await storage.get('presence', true);
      if (pRec?.value) setPresence(pRec.value);
      voteHandler();
    };
    const interval = setInterval(safetyTick, POLL_SAFETY);
    if (typeof window !== 'undefined' && window.storage?.onVotesChange) {
      window.storage.onVotesChange(voteHandler);
    }
    return () => {
      stopped = true;
      if (typeof storage.off === 'function') storage.off(handler);
      if (typeof window !== 'undefined' && window.storage?.offVotesChange) {
        window.storage.offVotesChange(voteHandler);
      }
      clearInterval(interval);
      offSyncRefresh();
    };
  }, [loaded, applyRemoteBoard]);

  /* ============================================================
     Timer tick + auto-end actions (admin only)
     ------------------------------------------------------------
     Tick at 1s while a vote session with a deadline is running so the
     countdown stays smooth, but fall back to 5s when the board is idle —
     `now` also gates online-presence freshness, and heartbeats fire every
     5s anyway. Cuts idle parent re-renders 5x.
     ============================================================ */
  const tickInterval = board.items.some((i) => i.type === 'zone' && i.voteTimer?.endsAt) ? 1000 : 5000;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickInterval);
    return () => clearInterval(id);
  }, [tickInterval]);

  // Sort sticky notes within their innermost containing zone by vote count
  // (desc), reposition, and end the session. Shared by both ways a voting
  // session can end: the deadline auto-expiring (below) and an admin
  // stopping it early (adminStopTimer) — both must produce the same result.
  const finalizeVotingSession = useCallback((zoneId) => {
    if (!isAdmin) return;
    const b = boardRef.current;
    const rootZone = b.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!rootZone?.voteTimer) return;
    // If zones overlap (e.g. Retro Loop's wrapper around Good/Bad/Try
    // columns), the smallest enclosing zone wins — otherwise the wrapper
    // would scoop up every sticky and pile them at its corner.
    const zones = [...zoneGroupIds(rootZone, b.items)]
      .map((id) => b.items.find((i) => i.id === id))
      // A descendant with its own live voteTimer runs an independent
      // session mutual exclusion should have prevented — never let this
      // root's widened finalize trample it (legacy cascaded boards in
      // flight across a deploy, or a same-instant start race).
      .filter((zone) => zone && zone.type === 'zone' && (zone.id === zoneId || !zone.voteTimer));
    const groupZoneIdSet = new Set(zones.map((zone) => zone.id));
    const stickies = b.items.filter((i) => i.type === 'sticky');
    const ownerByStickyId = new Map();
    stickies.forEach((s) => {
      const owner = effectiveOwnerZone(s, b.items);
      if (owner) ownerByStickyId.set(s.id, owner.id);
    });
    const newItems = [...b.items];
    // Derived geometry and z-order deltas to persist silently below.
    const geomEntries = [];
    let nextZIndex = Math.max(...b.items.map(effectiveZIndex)) + 1;
    const GAP = 24;       // gap between cards
    const PAD = 16;       // inner padding from zone edges
    zones.forEach((z) => {
      const children = stickies
        .filter((s) => ownerByStickyId.get(s.id) === z.id)
        .sort((a, c) => voteCountOf(c.id) - voteCountOf(a.id));
      if (children.length === 0) return;
      // Use the WIDEST sticky in this zone for column sizing so the grid
      // never overlaps when zones host different-sized stickies. Same for
      // row height. (Previously this used the global STICKY_W/H constants
      // which became too small after we scaled stickies to ~2.5% of zone
      // area, producing overlapping rows.)
      const colW = Math.max(...children.map((c) => c.w || STICKY_W));
      const rowH = Math.max(...children.map((c) => c.h || STICKY_H));
      const cols = Math.max(1, Math.floor((z.w - PAD * 2 + GAP) / (colW + GAP)));
      const rowsNeeded = Math.ceil(children.length / cols);
      const availH = Math.max(0, z.h - ZONE_TITLE_H - PAD * 2);
      // When the natural grid would spill below the zone, compress the
      // vertical step so rows overlap like a stacked deck of cards instead
      // of escaping the zone. Top-voted card stays at row 0; later rows
      // shingle downward.
      let rowStep = rowH + GAP;
      if (rowsNeeded > 1) {
        const fitStep = (availH - rowH) / (rowsNeeded - 1);
        if (fitStep < rowStep) rowStep = Math.max(1, fitStep);
      }
      children.forEach((s, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const targetX = z.x + PAD + col * (colW + GAP);
        const targetY = z.y + ZONE_TITLE_H + PAD + row * rowStep;
        const targetZIndex = nextZIndex + children.length - idx - 1;
        const k = newItems.findIndex((i) => i.id === s.id);
        if (k >= 0) {
          newItems[k] = {
            ...newItems[k],
            x: targetX,
            y: targetY,
            zIndex: targetZIndex,
          };
        }
        geomEntries.push({
          id: s.id,
          patch: { x: targetX, y: targetY, zIndex: targetZIndex },
        });
      });
      nextZIndex += children.length;
    });
    const finalizedAt = Date.now();
    // Optimistic local update (incl. z-order); persist geometry + meta silently
    // (derived change — propagates to peers but stays off the undo stack).
    setBoard((prev) => ({
      ...prev,
      items: newItems.map((it) => (it.id === zoneId ? { ...it, voteTimer: null, lastResultsAt: finalizedAt } : it)),
    }));
    if (geomEntries.length) {
      // The sort is an authoritative reposition — it must win over any
      // grace-period protection a prior drag left on these same ids,
      // otherwise the self-echoed 'system' write below gets reverted back
      // to the pre-sort dragged position by the recentlyMoved guard.
      geomEntries.forEach((e) => recentlyMovedRef.current.delete(e.id));
    }
    const allEntries = [
      ...geomEntries,
      { id: zoneId, patch: { voteTimer: null, lastResultsAt: finalizedAt } },
    ];
    if (allEntries.length) storage.updateItems(allEntries, { silent: true });
    let totalVotes = 0;
    const voters = new Set();
    const votesByUser = new Map();
    stickies
      .filter((s) => groupZoneIdSet.has(ownerByStickyId.get(s.id)))
      .forEach((s) => {
        const set = votesByItem.get(s.id);
        if (!set) return;
        totalVotes += set.size;
        set.forEach((v) => {
          voters.add(v);
          votesByUser.set(v, (votesByUser.get(v) || 0) + 1);
        });
      });
    let msg = t('vote.results', { n: totalVotes, users: voters.size });
    if (rootZone.voteTimer.showNonVoters) {
      const limit = rootZone.voteTimer.voteLimit;
      // With a quota, "incomplete" covers both zero votes and a partial
      // count (0/N is just the zero case of falling short of N) — one
      // unified list instead of two separate ones. Without a quota there's
      // no "full" to fall short of, so only the zero-vote case applies.
      const incomplete = limit != null
        ? onlineUsers
          .filter((u) => (votesByUser.get(u.userId) || 0) < limit)
          .map((u) => `${u.name} (${votesByUser.get(u.userId) || 0}/${limit})`)
        : onlineUsers.filter((u) => !voters.has(u.userId)).map((u) => u.name);
      if (incomplete.length) msg += ` ${t('vote.results.incompleteVoters', { names: incomplete.join(', ') })}`;
    }
    // Sticky: this can list every non-voter by name — the normal 3.2s
    // auto-dismiss isn't enough time to read it during a live meeting.
    setToast({ msg, type: 'info', sticky: true });
  }, [isAdmin, votesByItem, voteCountOf, onlineUsers, t]);

  useEffect(() => {
    if (!isAdmin) return;
    const expiredZone = board.items.find((i) => (
      i.type === 'zone' && i.voteTimer?.endsAt && i.voteTimer.endsAt <= now
    ));
    if (!expiredZone) return;
    const liveZone = boardRef.current.items.find((i) => i.id === expiredZone.id && i.type === 'zone');
    if (!liveZone?.voteTimer?.endsAt || liveZone.voteTimer.endsAt > Date.now()) return;
    finalizeVotingSession(expiredZone.id);
  }, [now, isAdmin, board.items, votesByItem, finalizeVotingSession]);

  /* ============================================================
     Persist viewport (per-user) — debounced lightly
     ============================================================ */
  useEffect(() => {
    if (!loaded) return undefined;
    const t = setTimeout(() => storage.set('viewport', viewport, false), 400);
    return () => clearTimeout(t);
  }, [viewport, loaded]);

  /* ============================================================
     Per-user vote count derived from shared board state.
     Counting actual votes cast keeps quotas in sync across devices and
     reset themselves automatically when admin clears votes.
     ============================================================ */
  const anyZoneVotingActive = useMemo(
    () => board.items.some((i) => i.type === 'zone' && i.voteTimer),
    [board.items],
  );

  // Strictest voteLimit among currently-active zone sessions — for the
  // player-list "quota full" badge. Concurrent zones can carry different
  // limits; the smallest is the one a player actually hits first.
  const activeZoneVoteLimit = useMemo(() => {
    const limits = board.items
      .filter((i) => i.type === 'zone' && i.voteTimer && (!i.voteTimer.endsAt || i.voteTimer.endsAt > now))
      .map((z) => z.voteTimer.voteLimit)
      .filter((l) => l != null);
    return limits.length ? Math.min(...limits) : null;
  }, [board.items, now]);

  const votesUsed = useMemo(() => {
    if (!userId || !anyZoneVotingActive) return 0;
    let count = 0;
    // Only count votes on cards still under an active session — a vote from
    // an earlier, already-finished session must not linger against a fresh
    // session's quota.
    votesByItem.forEach((set, id) => {
      if (!set.has(userId)) return;
      const item = board.items.find((i) => i.id === id);
      if (item && activeVoteZone(item, board.items, now)) count += 1;
    });
    return count;
  }, [votesByItem, userId, anyZoneVotingActive, board.items, now]);

  // Per-user vote tallies for the player list: userId → number of votes cast
  // on cards still under an active session (see votesUsed above).
  const votesUsedByUser = useMemo(() => {
    const m = new Map();
    if (!anyZoneVotingActive) return m;
    votesByItem.forEach((set, id) => {
      const item = board.items.find((i) => i.id === id);
      if (!item || !activeVoteZone(item, board.items, now)) return;
      set.forEach((uid) => { m.set(uid, (m.get(uid) || 0) + 1); });
    });
    return m;
  }, [votesByItem, anyZoneVotingActive, board.items, now]);

  /* ============================================================
     Auto-dismiss toast
     ============================================================ */
  useEffect(() => {
    if (!toast || toast.sticky) return undefined;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  /* Subscribe to Yjs undo-stack changes → toggles button enable/disable. */
  useEffect(() => {
    const sync = () => setUndoState({
      canUndo: !!window.storage?.canUndo?.(),
      canRedo: !!window.storage?.canRedo?.(),
    });
    sync();
    window.storage?.onUndoChange?.(sync);
    return () => window.storage?.offUndoChange?.(sync);
  }, []);

  // A drag in progress holds dragItemsRef, which applyRemoteBoard's merge
  // logic uses to keep showing the item at its live (not-yet-committed)
  // mouse position. Undoing mid-drag would apply the revert underneath that
  // override — invisible until the drag ends, and then the drag's own
  // trailing flush would overwrite the revert right back into Yjs.
  const midDrag = () => !!(dragItemsRef.current && dragItemsRef.current.size > 0);
  const doUndo = useCallback(() => {
    if (midDrag()) { setToast({ msg: t('topbar.finishDragFirst'), type: 'warn' }); return; }
    if (!window.storage?.undo?.()) setToast({ msg: t('topbar.nothingToUndo'), type: 'warn' });
  }, [t]);
  const doRedo = useCallback(() => {
    if (midDrag()) { setToast({ msg: t('topbar.finishDragFirst'), type: 'warn' }); return; }
    if (!window.storage?.redo?.()) setToast({ msg: t('topbar.nothingToRedo'), type: 'warn' });
  }, [t]);

  /* ============================================================
     Block browser zoom outside the board canvas.
     The canvas onWheel handles its own zoom; this catches pinch /
     ctrl+wheel over toolbars, keyboard zoom, and Safari gestures,
     plus counter-scales any zoom applied via the browser menu.
     ============================================================ */
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    const prevContent = meta?.getAttribute('content') || '';
    if (meta) {
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no',
      );
    }

    const onWheel = (e) => {
      // Canvas already preventDefaults its own wheel; this stops zoom
      // when pinch/ctrl-wheel happens over toolbars or modals.
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
    };
    const onGesture = (e) => e.preventDefault();

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('gesturestart', onGesture);
    window.addEventListener('gesturechange', onGesture);
    window.addEventListener('gestureend', onGesture);

    const baseDPR = window.devicePixelRatio || 1;
    const counterZoom = () => {
      const ratio = (window.devicePixelRatio || 1) / baseDPR;
      document.body.style.zoom = Math.abs(ratio - 1) > 0.01 ? String(1 / ratio) : '';
    };
    counterZoom();
    window.addEventListener('resize', counterZoom);
    window.visualViewport?.addEventListener('resize', counterZoom);

    return () => {
      if (meta) meta.setAttribute('content', prevContent);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('gesturestart', onGesture);
      window.removeEventListener('gesturechange', onGesture);
      window.removeEventListener('gestureend', onGesture);
      window.removeEventListener('resize', counterZoom);
      window.visualViewport?.removeEventListener('resize', counterZoom);
      document.body.style.zoom = '';
    };
  }, []);

  /* ============================================================
     Coordinate helpers
     ============================================================ */
  const screenToWorld = useCallback((sx, sy) => {
    const v = viewportRef.current;
    return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
  }, []);

  /* ============================================================
     Item operations
     ============================================================ */

  const removeItemUnchecked = useCallback((id) => {
    // One Yjs transaction so Cmd+Z restores the item AND its votes together.
    // Falls back to the two-call path if the bridge is an older build that
    // doesn't expose the combined helper yet.
    if (window.storage?.deleteItemWithVotes) {
      window.storage.deleteItemWithVotes(id);
      // React state still needs to drop the item — the deepObserver fires a
      // synthetic boardState change, but only for non-local origins. Our own
      // delete is 'local', so do it explicitly here.
      setBoard((prev) => ({ ...prev, items: prev.items.filter((it) => it.id !== id) }));
    } else {
      window.storage?.clearVotesFor?.(id);
      setBoard((prev) => ({ ...prev, items: prev.items.filter((it) => it.id !== id) }));
      storage.removeItem(id);
    }
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    if (focusedTextIdRef.current?.startsWith(`${id}:`)) updateFocusedText(null);
  }, [updateFocusedText]);

  const addSticky = useCallback((wx, wy) => {
    // Inherit the color of the deepest enclosing zone — when zones overlap
    // (e.g. Retro Loop's wrapper around the inner columns), the smallest one
    // wins so the sticky picks up the column color, not the frame's.
    const enclosingZone = resolveOwnerZone({
      id: null,
      type: 'sticky',
      x: wx - STICKY_W / 2,
      y: wy - STICKY_H / 2,
      w: STICKY_W,
      h: STICKY_H,
    }, boardRef.current.items);
    const color = enclosingZone
      ? enclosingZone.color
      : Math.floor(Math.random() * COLORS.length);
    // Target each sticky at ~2.5% of the enclosing zone's area, keeping the
    // default sticky aspect ratio so ~40 cards fit comfortably per zone.
    // Font size scales with sticky width so text stays readable on small
    // zones and isn't dwarfed on big ones.
    let w = STICKY_W;
    let h = STICKY_H;
    let fontSize;
    if (enclosingZone) {
      const ratio = STICKY_W / STICKY_H;
      const targetArea = enclosingZone.w * enclosingZone.h * 0.025;
      const targetW = Math.sqrt(targetArea * ratio);
      w = Math.round(Math.max(STICKY_MIN_W, Math.min(600, targetW)));
      h = Math.round(w / ratio);
      // Default sticky font is 15px at STICKY_W=200; scale linearly with width.
      fontSize = Math.max(11, Math.round(15 * (w / STICKY_W)));
    }
    const it = {
      id: uid(),
      type: 'sticky',
      x: wx - w / 2,
      y: wy - h / 2,
      w,
      h,
      authorId: userId,
      authorName: userName,
      createdAt: Date.now(),
      text: '',
      color,
      parentZoneId: enclosingZone?.id ?? null,
      rotation: (Math.random() * 3 - 1.5),
      private: true,
      ...(fontSize ? { fontSize } : {}),
    };
    addItemLocal(it);
    setSelectedId(it.id);
    updateFocusedText(`${it.id}:text`);
    setTimeout(() => editAreaRef.current?.focus(), 20);
  }, [userId, userName, addItemLocal, setSelectedId, updateFocusedText]);

  const addText = useCallback((wx, wy) => {
    const it = {
      id: uid(),
      type: 'text',
      x: wx,
      y: wy,
      w: TEXT_W,
      h: TEXT_H,
      authorId: userId,
      authorName: userName,
      createdAt: Date.now(),
      text: t('tool.text'),
    };
    it.parentZoneId = resolveOwnerZone(it, boardRef.current.items)?.id ?? null;
    addItemLocal(it);
    setSelectedId(it.id);
    updateFocusedText(`${it.id}:text`);
    setTimeout(() => {
      const el = editAreaRef.current;
      if (el) { el.focus(); el.select(); }
    }, 20);
  }, [userId, userName, addItemLocal, setSelectedId, updateFocusedText]);

  const addZone = useCallback((x, y, w, h, title = 'Untitled', color = 0) => {
    const it = {
      id: uid(),
      type: 'zone',
      x, y, w, h,
      title,
      color,
      authorId: userId,
      authorName: userName,
      createdAt: Date.now(),
    };
    it.parentZoneId = resolveOwnerZone(it, boardRef.current.items)?.id ?? null;
    addItemLocal(it);
    setSelectedId(it.id);
    return it.id;
  }, [userId, userName, addItemLocal, setSelectedId]);

  const addImage = useCallback((wx, wy, src, natW, natH) => {
    // Scale display size down if huge
    let dispW = natW;
    let dispH = natH;
    if (dispW > 480) {
      const r = 480 / dispW;
      dispW = 480;
      dispH = Math.round(natH * r);
    }
    const it = {
      id: uid(),
      type: 'image',
      x: wx - dispW / 2,
      y: wy - dispH / 2,
      w: dispW,
      h: dispH,
      natW,
      natH,
      src,
      authorId: userId,
      authorName: userName,
      createdAt: Date.now(),
    };
    it.parentZoneId = resolveOwnerZone(it, boardRef.current.items)?.id ?? null;
    addItemLocal(it);
    setSelectedId(it.id);
    return it.id;
  }, [userId, userName, addItemLocal, setSelectedId]);

  const importImageFromBlob = useCallback(async (blob, worldX, worldY) => {
    if (!blob || !blob.type || !blob.type.startsWith('image/')) return;
    if (!UPLOADABLE_IMAGE_TYPES.has(blob.type)) {
      setToast({ msg: t('image.unsupportedFormat') || 'Unsupported image format (PNG, JPEG, WEBP, or GIF only)', type: 'warn' });
      return;
    }
    if (blob.size > IMAGE_MAX_BYTES) {
      setToast({
        msg: t('image.tooLarge', { mb: (IMAGE_MAX_BYTES / 1024 / 1024).toFixed(0) })
          || `Image too large (max ${(IMAGE_MAX_BYTES / 1024 / 1024).toFixed(0)} MB)`,
        type: 'warn',
      });
      return;
    }
    const prepared = await prepareImageBlob(blob);
    if (!prepared) {
      setToast({
        msg: t('image.tooLarge', { mb: (IMAGE_MAX_BYTES / 1024 / 1024).toFixed(0) })
          || `Image too large (max ${(IMAGE_MAX_BYTES / 1024 / 1024).toFixed(0)} MB)`,
        type: 'warn',
      });
      return;
    }
    let url;
    try {
      url = await window.storage.uploadImage(prepared.blob);
    } catch {
      setToast({ msg: t('image.uploadFailed') || 'Image upload failed', type: 'warn' });
      return;
    }
    addImage(worldX, worldY, url, prepared.nw, prepared.nh);
  }, [addImage, setToast]);

  const applyTemplate = useCallback((key) => {
    const builtins = getTemplates();
    let tpl = builtins[key];
    if (!tpl) {
      const cust = customTemplates.find((c) => c.id === key);
      if (cust) tpl = { name: cust.name, zones: cust.zones };
    }
    if (!tpl || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const center = screenToWorld(rect.width / 2, rect.height / 2);
    const cx = (Math.min(...tpl.zones.map((z) => z.x)) + Math.max(...tpl.zones.map((z) => z.x + z.w))) / 2;
    const cy = (Math.min(...tpl.zones.map((z) => z.y)) + Math.max(...tpl.zones.map((z) => z.y + z.h))) / 2;
    const dx = center.x - cx;
    const dy = center.y - cy;
    const zones = tpl.zones.map((z) => ({
      id: uid(),
      type: 'zone',
      x: z.x + dx,
      y: z.y + dy,
      w: z.w,
      h: z.h,
      title: z.title,
      color: z.color,
      authorId: userId,
      authorName: userName,
      createdAt: Date.now(),
    }));
    zones.forEach((z) => { z.parentZoneId = resolveOwnerZone(z, zones)?.id ?? null; });
    addItemsLocal(zones);
    setTemplatesOpen(false);
  }, [userId, userName, addItemsLocal, screenToWorld, customTemplates]);

  const saveCurrentAsTemplate = useCallback((rawName) => {
    const name = (rawName || '').trim();
    if (!name) return;
    const zones = boardRef.current.items.filter((i) => i.type === 'zone');
    if (zones.length === 0) {
      setToast({ msg: t('tmpl.empty'), type: 'warn' });
      return;
    }
    const minX = Math.min(...zones.map((z) => z.x));
    const minY = Math.min(...zones.map((z) => z.y));
    const normalized = zones.map((z) => ({
      title: z.title, color: z.color,
      x: z.x - minX, y: z.y - minY, w: z.w, h: z.h,
    }));
    const next = [...customTemplates, { id: uid(), name, zones: normalized, createdAt: Date.now() }];
    setCustomTemplates(next);
    storage.set('customTemplates', next, true);
    setSaveTemplateOpen(false);
    setToast({ msg: t('tmpl.saved', { name }), type: 'info' });
  }, [customTemplates]);

  const deleteCustomTemplate = useCallback((id) => {
    const next = customTemplates.filter((t) => t.id !== id);
    setCustomTemplates(next);
    storage.set('customTemplates', next, true);
  }, [customTemplates]);

  /* ============================================================
     Admin gates
     ============================================================ */
  const editingAllowed = isAdmin || !board.editingLocked;
  const canModifyOwnedItem = useCallback((item) => editingAllowed, [editingAllowed]);

  const canDeleteItem = useCallback((item) => (
    canModifyOwnedItem(item) && !(item.type === 'zone' && item.locked)
  ), [canModifyOwnedItem]);

  const deleteItemsIfAllowed = useCallback((candidateIds) => {
    const ids = new Set(candidateIds);
    const items = boardRef.current.items.filter((item) => ids.has(item.id));
    if (!items.length) return false;
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
    if (!items.every(canDeleteItem)) {
      setToast({ msg: t('common.warnDeleteDenied'), type: 'warn' });
      return false;
    }
    items.forEach((item) => removeItemUnchecked(item.id));
    return true;
  }, [canDeleteItem, editingAllowed, removeItemUnchecked]);

  const zoneVotingSignature = useMemo(() => {
    const zones = board.items.filter((i) => i.type === 'zone');
    const stickies = board.items.filter((i) => i.type === 'sticky');
    return [
      ...zones.map((z) => `z:${z.id}:${z.x}:${z.y}:${z.w}:${z.h}:${z.voteTimer?.endsAt || 0}:${z.voteTimer?.voteLimit ?? ''}:${z.voteTimer?.hideResults ? 1 : 0}:${z.votingLocked ? 1 : 0}:${z.revealed == null ? '' : z.revealed ? 1 : 0}:${z.parentZoneId ?? ''}`),
      ...stickies.map((s) => `s:${s.id}:${s.x}:${s.y}:${s.w || STICKY_W}:${s.h || STICKY_H}:${Object.prototype.hasOwnProperty.call(s, 'parentZoneId') ? (s.parentZoneId || 'null') : 'unset'}`),
    ]
      .sort()
      .join('|');
  }, [board.items]);

  const stickyVotingContext = useMemo(() => {
    const map = new Map();
    const stickies = board.items.filter((i) => i.type === 'sticky');
    stickies.forEach((s) => {
      const zone = effectiveOwnerZone(s, board.items);
      const voteZone = activeVoteZone(s, board.items, now);
      const voteTimer = voteZone?.voteTimer;
      map.set(s.id, {
        votingAllowedNow: !!voteZone && !voteZone.votingLocked,
        hideVoteCounts: !!voteTimer?.hideResults && !isAdmin,
        revealed: effectiveRevealed(s, board.items, board.allRevealed),
        inZone: !!zone,
      });
    });
    return map;
    // Deliberately excludes now so active timers do not rebuild every sticky once per second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneVotingSignature, board.allRevealed, isAdmin]);

  const requireEdit = useCallback(() => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
    return true;
  }, [editingAllowed]);

  const requireMove = useCallback((candidateIds) => {
    const ids = Array.from(new Set(
      Array.from(candidateIds || []).filter((id) => typeof id === 'string' && id.length > 0),
    )).sort();
    const focusedItemId = focusedTextIdRef.current?.split(':')[0] || null;
    if (focusedItemId && ids.includes(focusedItemId)) return false;
    if (storage.findRemoteBusyItem(ids)) {
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      return false;
    }
    storage.setLocalBusyItems('geometry', ids);
    return true;
  }, []);

  /* ============================================================
     Voting
     ============================================================ */
  const toggleVote = useCallback((it) => {
    const items = boardRef.current.items;
    const voteZone = activeVoteZone(it, items, Date.now());
    const zTimer = voteZone?.voteTimer;
    const allowed = !!voteZone && !voteZone.votingLocked;
    if (!allowed) {
      setToast({ msg: t('vote.notStarted'), type: 'warn' });
      return;
    }
    if (!window.storage?.setVote) return;
    // Read the live Yjs snapshot (not React state) so rapid clicks and
    // concurrent remote writes see the latest value.
    const live = window.storage.snapshotVotes();
    const has = !!live.get(it.id)?.has(userId);
    if (!has && zTimer.voteLimit != null) {
      let used = 0;
      // Only count votes on cards still under an active session — a vote
      // cast in an earlier, already-finished session (anywhere on the
      // board) must not eat into a brand-new session's quota.
      live.forEach((set, id) => {
        if (!set.has(userId)) return;
        const votedItem = items.find((i) => i.id === id);
        if (votedItem && activeVoteZone(votedItem, items, Date.now())) used += 1;
      });
      if (used >= zTimer.voteLimit) {
        setToast({ msg: t('vote.outOfQuota'), type: 'warn' });
        return;
      }
    }
    window.storage.setVote(it.id, userId, !has);
    if (!has) flashVote(it.id);
  }, [userId, flashVote, t]);

  /* ============================================================
     Interactions: pan, zoom, drag, resize
     ============================================================ */

  // Apply a viewport directly to the DOM, bypassing React. Used during pan so
  // a board with hundreds of cards doesn't run the React commit phase on every
  // mousemove — pan becomes a single GPU-composited transform.
  const applyViewportToDom = useCallback((v) => {
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    }
    if (gridRef.current) {
      const s = 24 * v.zoom;
      gridRef.current.style.backgroundSize = `${s}px ${s}px`;
      gridRef.current.style.backgroundPosition = `${v.x}px ${v.y}px`;
    }
  }, []);

  // Keep the DOM in sync with React state for non-live changes (fit, reset,
  // initial load). Continuous wheel/pan input applies directly to the DOM,
  // and its final commit brings React state back into sync.
  useEffect(() => {
    if (interactionRef.current === null) applyViewportToDom(viewport);
  }, [viewport, applyViewportToDom]);

  const liveApplyViewport = useCallback((next) => {
    viewportRef.current = next;
    applyViewportToDom(next);
  }, [applyViewportToDom]);

  // Wheel input is the noisiest input on the page — trackpads / Magic Mice
  // can fire 120+ events/sec. Each event used to force a layout via
  // getBoundingClientRect and write to the DOM, which manifested as zoom
  // jitter. Coalesce events into one rAF tick: cache rect once, fold every
  // queued delta on top of the current viewport, then write the final
  // transform once per frame.
  const wheelCommitRef = useRef(null);
  const wheelRafRef = useRef(null);
  const wheelQueueRef = useRef([]);
  const cancelPendingWheel = useCallback(() => {
    if (wheelRafRef.current != null) {
      cancelAnimationFrame(wheelRafRef.current);
      wheelRafRef.current = null;
    }
    wheelQueueRef.current = [];
    if (wheelCommitRef.current != null) {
      clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = null;
    }
  }, []);

  const commitViewportImmediately = useCallback((next) => {
    cancelPendingWheel();
    viewportRef.current = next;
    applyViewportToDom(next);
    setViewport(next);
  }, [applyViewportToDom, cancelPendingWheel]);

  // A gesture starting after a live wheel frame must preserve that frame while
  // discarding any not-yet-applied wheel events. This prevents a later React
  // render from restoring the viewport that preceded the gesture.
  const settleWheelBeforeInteraction = useCallback(() => {
    if (wheelCommitRef.current != null) {
      commitViewportImmediately(viewportRef.current);
    } else {
      cancelPendingWheel();
    }
  }, [cancelPendingWheel, commitViewportImmediately]);

  // Cancel any in-flight rAF / trailing commit on unmount so the deferred
  // setViewport callback can't fire after React tore the tree down (would log
  // a "setState on unmounted" warning and leak the closure's refs).
  useEffect(() => () => cancelPendingWheel(), [cancelPendingWheel]);

  const onCanvasWheel = useCallback((e) => {
    e.preventDefault();
    if (interactionRef.current !== null) {
      cancelPendingWheel();
      return;
    }
    let deltaX = e.deltaX;
    let deltaY = e.deltaY;
    if (e.deltaMode === 1) {
      deltaX *= 16;
      deltaY *= 16;
    } else if (e.deltaMode === 2) {
      deltaX *= canvasRef.current?.clientWidth || window.innerWidth;
      deltaY *= canvasRef.current?.clientHeight || window.innerHeight;
    }
    const shouldZoom = (e.ctrlKey || e.metaKey) !== scrollWheelZoomEnabledRef.current;
    if (shouldZoom && deltaY === 0) return;
    wheelQueueRef.current.push({
      kind: shouldZoom ? 'zoom' : 'pan',
      deltaX,
      deltaY,
      clientX: e.clientX,
      clientY: e.clientY,
    });
    if (wheelRafRef.current != null) return;
    wheelRafRef.current = requestAnimationFrame(() => {
      wheelRafRef.current = null;
      const events = wheelQueueRef.current;
      wheelQueueRef.current = [];
      if (interactionRef.current !== null || !events.length || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      let v = viewportRef.current;
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i];
        if (ev.kind === 'pan') {
          v = { ...v, x: v.x - ev.deltaX, y: v.y - ev.deltaY };
        } else {
          const factor = ev.deltaY < 0 ? 1.05 : 1 / 1.05;
          v = zoomViewportAt(v, v.zoom * factor, {
            x: ev.clientX - rect.left,
            y: ev.clientY - rect.top,
          });
        }
      }
      liveApplyViewport(v);
      if (wheelCommitRef.current) clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = setTimeout(() => {
        wheelCommitRef.current = null;
        setViewport(viewportRef.current);
      }, 120);
    });
  }, [cancelPendingWheel, liveApplyViewport]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', onCanvasWheel, { passive: false });
    return () => el.removeEventListener('wheel', onCanvasWheel);
  }, [onCanvasWheel, loaded]);

  const startPan = useCallback((e) => {
    if (interactionRef.current !== null) return false;
    e.preventDefault();
    e.stopPropagation();
    settleWheelBeforeInteraction();
    const start = {
      x: e.clientX,
      y: e.clientY,
      vx: viewportRef.current.x,
      vy: viewportRef.current.y,
      zoom: viewportRef.current.zoom,
    };
    interactionRef.current = { kind: 'pan' };
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    let finished = false;
    let panRaf = null;
    let panPending = null;
    const apply = (clientX, clientY) => {
      liveApplyViewport({
        zoom: start.zoom,
        x: start.vx + (clientX - start.x),
        y: start.vy + (clientY - start.y),
      });
    };
    const onMove = (ev) => {
      panPending = { x: ev.clientX, y: ev.clientY };
      if (panRaf != null) return;
      panRaf = requestAnimationFrame(() => {
        panRaf = null;
        const p = panPending;
        panPending = null;
        if (p) apply(p.x, p.y);
      });
    };
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (panRaf != null) { cancelAnimationFrame(panRaf); panRaf = null; }
      if (panPending) { const p = panPending; panPending = null; apply(p.x, p.y); }
      interactionRef.current = null;
      removeListeners();
      if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = spaceHeldRef.current ? 'grab' : '';
      setViewport(viewportRef.current);
    };
    const onUp = () => finalize();
    const onBlur = () => finalize();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeViewportFinalizerRef.current = onBlur;
    return true;
  }, [liveApplyViewport, settleWheelBeforeInteraction]);

  const onCanvasMouseDownCapture = useCallback((e) => {
    if (!spaceHeldRef.current && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    startPan(e);
  }, [startPan]);

  const onCanvasMouseDown = useCallback((e) => {
    // Only start pan/marquee if mousedown is on the canvas (not on an item) —
    // unless Space is held, in which case any mousedown always pans (the
    // card's own handler lets the event through; see startItemDrag/startZoneDrag).
    if (!spaceHeldRef.current && e.target !== canvasRef.current && e.target.dataset?.surface !== '1') return;
    if (focusedTextIdRef.current) {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    }
    // Zone-creation tool: drag rectangle on canvas to place a new zone.
    if (!spaceHeldRef.current && creationModeRef.current === 'zone' && requireEdit()) {
      e.preventDefault();
      settleWheelBeforeInteraction();
      const rect = canvasRef.current.getBoundingClientRect();
      const start = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      let lastWorld = start;
      let finished = false;
      interactionRef.current = { kind: 'creating-zone' };
      const onMove = (ev) => {
        lastWorld = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
        const x = Math.min(start.x, lastWorld.x);
        const y = Math.min(start.y, lastWorld.y);
        const w = Math.abs(lastWorld.x - start.x);
        const h = Math.abs(lastWorld.y - start.y);
        setZonePreview({ x, y, w, h });
      };
      const removeListeners = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', onBlur);
      };
      const finalize = (complete) => {
        if (finished) return;
        finished = true;
        interactionRef.current = null;
        removeListeners();
        if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
        setZonePreview(null);
        if (!complete) return;
        setCreationMode(null);
        const x = Math.min(start.x, lastWorld.x);
        const y = Math.min(start.y, lastWorld.y);
        const w = Math.max(ZONE_MIN_W, Math.abs(lastWorld.x - start.x));
        const h = Math.max(ZONE_MIN_H, Math.abs(lastWorld.y - start.y));
        const id = addZone(x, y, w, h);
        // Focus the new zone's title so the user can name it.
        updateFocusedText(`${id}:title`);
        setTimeout(() => {
          editAreaRef.current?.focus();
          editAreaRef.current?.select?.();
        }, 30);
      };
      const onUp = () => finalize(true);
      const onBlur = () => finalize(false);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onBlur);
      activeViewportFinalizerRef.current = onBlur;
      return;
    }
    const selectTool = creationModeRef.current === 'select';
    const useMarquee = !spaceHeldRef.current && (e.shiftKey || e.button === 2 || selectTool);
    if (!e.shiftKey) setSelectedIds(new Set());
    if (useMarquee) {
      // Box select
      const start = { x: e.clientX, y: e.clientY };
      const baseSelection = e.shiftKey ? new Set(selectedIds) : new Set();
      let finished = false;
      settleWheelBeforeInteraction();
      interactionRef.current = { kind: 'marquee' };
      setMarquee({ x1: start.x, y1: start.y, x2: start.x, y2: start.y });
      const onMove = (ev) => {
        setMarquee({ x1: start.x, y1: start.y, x2: ev.clientX, y2: ev.clientY });
      };
      const removeListeners = () => {
        window.removeEventListener('mousemove', onMoveTracked);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', onBlur);
      };
      const finalize = (complete) => {
        if (finished) return;
        finished = true;
        interactionRef.current = null;
        removeListeners();
        if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
        setMarquee(null);
        if (!complete) return;
        const m = { x1: Math.min(start.x, lastX), y1: Math.min(start.y, lastY), x2: Math.max(start.x, lastX), y2: Math.max(start.y, lastY) };
        const v = viewportRef.current;
        const wx1 = (m.x1 - v.x) / v.zoom;
        const wy1 = (m.y1 - v.y) / v.zoom;
        const wx2 = (m.x2 - v.x) / v.zoom;
        const wy2 = (m.y2 - v.y) / v.zoom;
        const hits = boardRef.current.items.filter((it) => {
          const c = centerOf(it);
          return c.x >= wx1 && c.x <= wx2 && c.y >= wy1 && c.y <= wy2;
        }).map((it) => it.id);
        const next = new Set(baseSelection);
        hits.forEach((id) => next.add(id));
        setSelectedIds(next);
      };
      let lastX = start.x;
      let lastY = start.y;
      const onMoveTracked = (ev) => { lastX = ev.clientX; lastY = ev.clientY; onMove(ev); };
      const onUp = () => finalize(true);
      const onBlur = () => finalize(false);
      window.addEventListener('mousemove', onMoveTracked);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onBlur);
      activeViewportFinalizerRef.current = onBlur;
      return;
    }
    if (e.button === 0) startPan(e);
  }, [
    selectedIds, requireEdit, screenToWorld, addZone,
    settleWheelBeforeInteraction, startPan, updateFocusedText,
  ]);

  const fitToContent = useCallback(() => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(fitViewportToItems(boardRef.current.items, rect.width, rect.height));
  }, [commitViewportImmediately]);

  const fitToSelection = useCallback(() => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    const ids = selectedIdsRef.current;
    if (ids.size === 0) return;
    const items = boardRef.current.items.filter((it) => ids.has(it.id));
    if (items.length === 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(fitViewportToItems(items, rect.width, rect.height));
  }, [commitViewportImmediately]);

  const zoomBy = useCallback((factor) => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    const current = viewportRef.current;
    commitViewportImmediately(zoomViewportAt(current, current.zoom * factor, center));
  }, [commitViewportImmediately]);

  const resetZoom = useCallback(() => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(zoomViewportAt(viewportRef.current, 1, {
      x: rect.width / 2,
      y: rect.height / 2,
    }));
  }, [commitViewportImmediately]);

  const updateZIndexes = useCallback((entries) => {
    const byId = new Map(entries.map((entry) => [entry.id, entry.patch.zIndex]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (
        byId.has(it.id) ? { ...it, zIndex: byId.get(it.id) } : it
      )),
    }));
    storage.updateItems(entries);
  }, []);

  const bringToFront = useCallback((ids) => {
    if (!ids?.size || interactionRef.current !== null) return;
    const items = boardRef.current.items;
    const targetIds = new Set(ids);
    items.forEach((it) => {
      if (it.type === 'zone' && ids.has(it.id)) {
        zoneGroupIds(it, items).forEach((id) => targetIds.add(id));
      }
    });
    const selected = items
      .filter((it) => targetIds.has(it.id))
      .sort(compareZOrder);
    if (selected.length === 0 || !requireEdit()) return;
    if (!selected.every(canModifyOwnedItem)) return;
    const maxZ = Math.max(...items.map(effectiveZIndex));
    updateZIndexes(selected.map((it, index) => ({
      id: it.id,
      patch: { zIndex: maxZ + index + 1 },
    })));
  }, [canModifyOwnedItem, requireEdit, updateZIndexes]);

  const sendToBack = useCallback((ids) => {
    if (!ids?.size || interactionRef.current !== null) return;
    const items = boardRef.current.items;
    const targetIds = new Set(ids);
    items.forEach((it) => {
      if (it.type === 'zone' && ids.has(it.id)) {
        zoneGroupIds(it, items).forEach((id) => targetIds.add(id));
      }
    });
    const selected = items
      .filter((it) => targetIds.has(it.id))
      .sort((a, b) => compareZOrder(b, a));
    if (selected.length === 0 || !requireEdit()) return;
    if (!selected.every(canModifyOwnedItem)) return;
    const minZ = Math.min(...items.map(effectiveZIndex));
    updateZIndexes(selected.map((it, index) => ({
      id: it.id,
      patch: { zIndex: minZ - index - 1 },
    })));
  }, [canModifyOwnedItem, requireEdit, updateZIndexes]);

  const bringForward = useCallback((id) => {
    if (!id || interactionRef.current !== null) return;
    if (selectedIdsRef.current.size !== 1 || !selectedIdsRef.current.has(id)) return;
    const items = [...boardRef.current.items].sort(compareZOrder);
    const index = items.findIndex((it) => it.id === id);
    if (index < 0 || index === items.length - 1) return;
    if (!requireEdit()) return;
    const entries = swapZOrderEntries(items, index, index + 1);
    const currentById = new Map(boardRef.current.items.map((it) => [it.id, it]));
    if (!entries.every((entry) => {
      const current = currentById.get(entry.id);
      return current && canModifyOwnedItem(current);
    })) return;
    updateZIndexes(entries);
  }, [canModifyOwnedItem, requireEdit, updateZIndexes]);

  const sendBackward = useCallback((id) => {
    if (!id || interactionRef.current !== null) return;
    if (selectedIdsRef.current.size !== 1 || !selectedIdsRef.current.has(id)) return;
    const items = [...boardRef.current.items].sort(compareZOrder);
    const index = items.findIndex((it) => it.id === id);
    if (index <= 0) return;
    if (!requireEdit()) return;
    const entries = swapZOrderEntries(items, index, index - 1);
    const currentById = new Map(boardRef.current.items.map((it) => [it.id, it]));
    if (!entries.every((entry) => {
      const current = currentById.get(entry.id);
      return current && canModifyOwnedItem(current);
    })) return;
    updateZIndexes(entries);
  }, [canModifyOwnedItem, requireEdit, updateZIndexes]);

  const onCanvasDoubleClick = useCallback((e) => {
    if (e.target !== canvasRef.current && e.target.dataset?.surface !== '1') return;
    if (!requireEdit()) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    addSticky(w.x, w.y);
  }, [addSticky, requireEdit, screenToWorld]);

  /* ----- Item drag (supports group when multi-selected) ----- */
  const startItemDrag = useCallback((e, item) => {
    // Space held → let the mousedown bubble to onCanvasMouseDown and pan
    // instead of dragging the card underneath the cursor.
    if (spaceHeldRef.current) return;
    e.stopPropagation();
    const shiftToggle = e.shiftKey;
    // Read selection from a ref so this callback's identity is stable across
    // selection changes — otherwise every selection click would invalidate
    // every memoized card via the renderedItems deps array.
    const currentSelection = new Set(selectedIdsRef.current);
    let dragIds;
    if (shiftToggle) {
      if (currentSelection.has(item.id)) currentSelection.delete(item.id);
      else currentSelection.add(item.id);
      dragIds = new Set(currentSelection);
    } else if (currentSelection.has(item.id) && currentSelection.size > 1) {
      dragIds = new Set(currentSelection);
    } else {
      dragIds = new Set([item.id]);
    }
    const primaryIds = dragIds;
    const start = { x: e.clientX, y: e.clientY };
    let lastClient = { x: start.x, y: start.y };
    const seeds = new Map();
    boardRef.current.items.forEach((it) => {
      if (dragIds.has(it.id)) seeds.set(it.id, { x: it.x, y: it.y });
    });
    let moved = false;
    let claimed = false;
    let finished = false;
    settleWheelBeforeInteraction();
    interactionRef.current = { kind: 'maybe-drag' };
    // Coalesce mousemove updates to one per animation frame so trackpads /
    // high-refresh displays don't fire React updates faster than the screen
    // can paint them.
    let rafId = null;
    let pending = null;
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      storage.offBusyChange(onBusyChange);
    };
    const abortGesture = () => {
      if (finished) return;
      finished = true;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      pending = null;
      if (moved) discardPendingGeometry();
      dragItemsRef.current = null;
      if (claimed) storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
    };
    const onBusyChange = () => {
      if (!storage.findRemoteBusyItem(Array.from(seeds.keys()))) return;
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      abortGesture();
    };
    const applyMove = (clientX, clientY, isFinal = false) => {
      lastClient = { x: clientX, y: clientY };
      const dx = clientX - start.x;
      const dy = clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        if (!requireMove(seeds.keys())) { abortGesture(); return; }
        claimed = true;
        moved = true;
        interactionRef.current = { kind: 'drag' };
        dragItemsRef.current = new Set(seeds.keys());
        storage.onBusyChange(onBusyChange);
      }
      const z = viewportRef.current.zoom;
      const wx = dx / z;
      const wy = dy / z;
      const entries = [];
      seeds.forEach((seed, id) => entries.push({ id, patch: { x: seed.x + wx, y: seed.y + wy } }));
      if (isFinal) {
        const patchById = new Map(entries.map((entry) => [entry.id, entry.patch]));
        const finalItems = boardRef.current.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        ));
        primaryIds.forEach((id) => {
          const it = finalItems.find((i) => i.id === id);
          if (!it || (it.type === 'zone' && it.locked)) return;
          const newParentId = resolveOwnerZone(it, finalItems)?.id ?? null;
          if (!Object.prototype.hasOwnProperty.call(it, 'parentZoneId') || it.parentZoneId !== newParentId) {
            const entry = entries.find((en) => en.id === id);
            if (entry) entry.patch.parentZoneId = newParentId;
            else entries.push({ id, patch: { parentZoneId: newParentId } });
          }
          if (it.type === 'zone') {
            finalItems.forEach((child) => {
              if (child.parentZoneId === id && !insideZone(centerOf(child), it)) {
                entries.push({ id: child.id, patch: { parentZoneId: null } });
              }
            });
          }
        });
      }
      commitGeometry(entries);
    };
    const onMove = (ev) => {
      pending = { x: ev.clientX, y: ev.clientY };
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const p = pending;
        pending = null;
        if (p) applyMove(p.x, p.y);
      });
    };
    const finalize = (allowClick) => {
      if (finished) return;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      if (pending) { const p = pending; pending = null; applyMove(p.x, p.y); }
      if (finished) return;
      finished = true;
      if (moved) {
        applyMove(lastClient.x, lastClient.y, true);
        endGeometry();
      }
      dragItemsRef.current = null;
      if (claimed) storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
      if (allowClick && !moved) {
        if (shiftToggle) setSelectedIds(dragIds);
        else setSelectedId(item.id);
      } else {
        if (moved) setSelectedIds(dragIds);
      }
    };
    const onUp = () => finalize(true);
    const onBlur = () => finalize(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeGeometryFinalizerRef.current = onBlur;
  }, [
    requireMove, commitGeometry, endGeometry, discardPendingGeometry,
    setSelectedId, settleWheelBeforeInteraction,
  ]);

  /* ----- Zone title drag (with children) ----- */
  const startZoneDrag = useCallback((e, zone) => {
    // Space held → let the mousedown bubble to onCanvasMouseDown and pan
    // instead of dragging the zone underneath the cursor.
    if (spaceHeldRef.current) return;
    e.stopPropagation();
    // Locked zone's own title bar: select it (so the toolbar with the unlock
    // button appears) but don't enter a drag gesture. commitGeometry also
    // filters locked-zone patches, but bailing here avoids a dead drag state.
    if (zone.locked) { setSelectedId(zone.id); return; }
    // If this zone is part of a multi-selection, drag every selected item as a
    // group — matches the marquee/shift-select expectation. Otherwise fall back
    // to the "zone carries its contents" behavior, including nested zones that
    // are strictly contained (so the Retro Loop wrapper moves the whole template).
    // Read selection via ref so this callback stays stable across selections.
    const liveSelectedIds = selectedIdsRef.current;
    const inMultiSelect = liveSelectedIds.has(zone.id) && liveSelectedIds.size > 1;
    const primaryIds = inMultiSelect ? new Set(liveSelectedIds) : new Set([zone.id]);
    const draggedIds = new Set();
    if (inMultiSelect) {
      liveSelectedIds.forEach((id) => draggedIds.add(id));
    } else {
      zoneGroupIds(zone, boardRef.current.items).forEach((id) => draggedIds.add(id));
    }
    const start = { x: e.clientX, y: e.clientY };
    let lastClient = { x: start.x, y: start.y };
    const initial = new Map();
    boardRef.current.items.forEach((it) => {
      if (draggedIds.has(it.id)) initial.set(it.id, { x: it.x, y: it.y });
    });
    let moved = false;
    let claimed = false;
    let finished = false;
    settleWheelBeforeInteraction();
    interactionRef.current = { kind: 'maybe-drag' };
    // See startItemDrag for why we coalesce mousemove via rAF.
    let rafId = null;
    let pending = null;
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      storage.offBusyChange(onBusyChange);
    };
    const abortGesture = () => {
      if (finished) return;
      finished = true;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      pending = null;
      if (moved) discardPendingGeometry();
      dragItemsRef.current = null;
      if (claimed) storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
    };
    const onBusyChange = () => {
      if (!storage.findRemoteBusyItem(Array.from(initial.keys()))) return;
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      abortGesture();
    };
    const applyMove = (clientX, clientY, isFinal = false) => {
      lastClient = { x: clientX, y: clientY };
      const dx = clientX - start.x;
      const dy = clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        if (!requireMove(initial.keys())) { abortGesture(); return; }
        claimed = true;
        moved = true;
        interactionRef.current = { kind: 'drag' };
        dragItemsRef.current = new Set(initial.keys());
        storage.onBusyChange(onBusyChange);
      }
      const z = viewportRef.current.zoom;
      const wx = dx / z;
      const wy = dy / z;
      const entries = [];
      initial.forEach((seed, id) => entries.push({ id, patch: { x: seed.x + wx, y: seed.y + wy } }));
      if (isFinal) {
        const patchById = new Map(entries.map((entry) => [entry.id, entry.patch]));
        const finalItems = boardRef.current.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        ));
        primaryIds.forEach((id) => {
          const it = finalItems.find((i) => i.id === id);
          if (!it || (it.type === 'zone' && it.locked)) return;
          const newParentId = resolveOwnerZone(it, finalItems)?.id ?? null;
          if (!Object.prototype.hasOwnProperty.call(it, 'parentZoneId') || it.parentZoneId !== newParentId) {
            const entry = entries.find((en) => en.id === id);
            if (entry) entry.patch.parentZoneId = newParentId;
            else entries.push({ id, patch: { parentZoneId: newParentId } });
          }
          if (it.type === 'zone') {
            finalItems.forEach((child) => {
              if (child.parentZoneId === id && !insideZone(centerOf(child), it)) {
                entries.push({ id: child.id, patch: { parentZoneId: null } });
              }
            });
          }
        });
      }
      commitGeometry(entries);
    };
    const onMove = (ev) => {
      pending = { x: ev.clientX, y: ev.clientY };
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const p = pending;
        pending = null;
        if (p) applyMove(p.x, p.y);
      });
    };
    const finalize = (allowClick) => {
      if (finished) return;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      if (pending) { const p = pending; pending = null; applyMove(p.x, p.y); }
      if (finished) return;
      finished = true;
      if (moved) {
        applyMove(lastClient.x, lastClient.y, true);
        endGeometry();
      }
      dragItemsRef.current = null;
      if (claimed) storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
      if (allowClick && !moved) setSelectedId(zone.id);
    };
    const onUp = () => finalize(true);
    const onBlur = () => finalize(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeGeometryFinalizerRef.current = onBlur;
  }, [
    requireMove, commitGeometry, endGeometry, discardPendingGeometry,
    setSelectedId, settleWheelBeforeInteraction,
  ]);

  /* ----- Generic item resize (zone / sticky / image / text) ----- */
  const startItemResize = useCallback((e, item, corner) => {
    if (spaceHeldRef.current || e.button === 1) { startPan(e); return; }
    if (item.type === 'zone' && item.locked) return;
    e.stopPropagation();
    let minW = ZONE_MIN_W;
    let minH = ZONE_MIN_H;
    if (item.type === 'sticky') { minW = STICKY_MIN_W; minH = STICKY_MIN_H; }
    else if (item.type === 'image') { minW = IMAGE_MIN_W; minH = IMAGE_MIN_H; }
    else if (item.type === 'text') { minW = TEXT_MIN_W; minH = TEXT_MIN_H; }
    const aspectLock = item.type === 'image' && !e.altKey;
    const w0 = item.w || (item.type === 'sticky' ? STICKY_W : item.type === 'text' ? TEXT_W : 200);
    const h0 = item.h || (item.type === 'sticky' ? STICKY_H : item.type === 'text' ? TEXT_H : 200);
    const start = { x: e.clientX, y: e.clientY };
    const initial = { x: item.x, y: item.y, w: w0, h: h0 };
    if (!requireMove([item.id])) return;
    settleWheelBeforeInteraction();
    interactionRef.current = { kind: 'drag' };
    dragItemsRef.current = new Set([item.id]);
    let finished = false;
    let lastEntries = null;
    const onMove = (ev) => {
      const z = viewportRef.current.zoom;
      let dx = (ev.clientX - start.x) / z;
      let dy = (ev.clientY - start.y) / z;
      if (aspectLock) {
        // Convert raw deltas into "growth" along each axis (positive = larger).
        // signX/signY map a corner's outward direction onto +growth.
        const signX = (corner === 'nw' || corner === 'sw') ? -1 : 1;
        const signY = (corner === 'nw' || corner === 'ne') ? -1 : 1;
        const sx = (initial.w + signX * dx) / initial.w;
        const sy = (initial.h + signY * dy) / initial.h;
        // Drive by whichever axis deviated more from 1.0 (proportional drag).
        const scale = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
        dx = signX * initial.w * (scale - 1);
        dy = signY * initial.h * (scale - 1);
      }
      let { x, y, w, h } = initial;
      if (corner === 'nw') {
        x = initial.x + dx; y = initial.y + dy; w = initial.w - dx; h = initial.h - dy;
      } else if (corner === 'ne') {
        y = initial.y + dy; w = initial.w + dx; h = initial.h - dy;
      } else if (corner === 'sw') {
        x = initial.x + dx; w = initial.w - dx; h = initial.h + dy;
      } else if (corner === 'se') {
        w = initial.w + dx; h = initial.h + dy;
      }
      if (w < minW) {
        if (corner === 'nw' || corner === 'sw') x = initial.x + (initial.w - minW);
        w = minW;
      }
      if (h < minH) {
        if (corner === 'nw' || corner === 'ne') y = initial.y + (initial.h - minH);
        h = minH;
      }
      lastEntries = [{ id: item.id, patch: { x, y, w, h } }];
      commitGeometry(lastEntries);
    };
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      storage.offBusyChange(onBusyChange);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (lastEntries) {
        const entries = lastEntries.map((entry) => ({ id: entry.id, patch: { ...entry.patch } }));
        const patchById = new Map(entries.map((entry) => [entry.id, entry.patch]));
        const finalItems = boardRef.current.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        ));
        const finalSelf = finalItems.find((it) => it.id === item.id);
        // Durable self-orphan: resizing off an explicitly-tracked owner must
        // drop it for good, same as a drag would — otherwise it silently
        // reattaches the moment that zone is later moved/resized back over it.
        if (finalSelf && Object.prototype.hasOwnProperty.call(item, 'parentZoneId') && item.parentZoneId) {
          const owner = finalItems.find((it) => it.id === item.parentZoneId && it.type === 'zone');
          if (!owner || !insideZone(centerOf(finalSelf), owner)) {
            const entry = entries.find((en) => en.id === item.id);
            if (entry) entry.patch.parentZoneId = null;
            else entries.push({ id: item.id, patch: { parentZoneId: null } });
          }
        }
        if (item.type === 'zone' && finalSelf) {
          finalItems.forEach((child) => {
            if (child.parentZoneId === item.id && !insideZone(centerOf(child), finalSelf)) {
              const entry = entries.find((en) => en.id === child.id);
              if (entry) entry.patch.parentZoneId = null;
              else entries.push({ id: child.id, patch: { parentZoneId: null } });
            }
          });
        }
        commitGeometry(entries);
      }
      endGeometry();
      dragItemsRef.current = null;
      storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
    };
    const onBusyChange = () => {
      if (!storage.findRemoteBusyItem([item.id])) return;
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      finalize();
    };
    const onUp = () => finalize();
    const onBlur = () => finalize();
    storage.onBusyChange(onBusyChange);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeGeometryFinalizerRef.current = onBlur;
  }, [requireMove, commitGeometry, endGeometry, settleWheelBeforeInteraction, startPan]);

  /* ----- Group resize (scales all selected items around opposite corner) ----- */
  const startGroupResize = useCallback((e, corner) => {
    if (spaceHeldRef.current || e.button === 1) { startPan(e); return; }
    e.stopPropagation();
    const items = boardRef.current.items.filter((it) => selectedIds.has(it.id));
    if (items.length < 2) return;
    const originalById = new Map(items.map((it) => [it.id, it]));
    // Snapshot initial bbox and per-item geometry.
    let minX = Infinity; let minY = Infinity;
    let maxX = -Infinity; let maxY = -Infinity;
    const seeds = new Map();
    items.forEach((it) => {
      const w = it.w || (it.type === 'sticky' ? STICKY_W : it.type === 'image' ? 200 : it.type === 'text' ? TEXT_W : 0);
      const h = it.h || (it.type === 'sticky' ? STICKY_H : it.type === 'image' ? 200 : it.type === 'text' ? TEXT_H : 0);
      seeds.set(it.id, { type: it.type, x: it.x, y: it.y, w, h });
      if (it.x < minX) minX = it.x;
      if (it.y < minY) minY = it.y;
      if (it.x + w > maxX) maxX = it.x + w;
      if (it.y + h > maxY) maxY = it.y + h;
    });
    const initBBox = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    // Anchor = opposite corner (stays fixed in world space).
    const ax = (corner === 'nw' || corner === 'sw') ? initBBox.x + initBBox.w : initBBox.x;
    const ay = (corner === 'nw' || corner === 'ne') ? initBBox.y + initBBox.h : initBBox.y;
    const start = { x: e.clientX, y: e.clientY };
    const aspectLock = !e.altKey; // hold Alt to scale freely on both axes
    const aspect = initBBox.w / initBBox.h;
    // Smallest allowed scale so no item drops below its per-type minimum.
    let minScaleX = 0.1;
    let minScaleY = 0.1;
    seeds.forEach((s) => {
      if (s.w > 0) {
        const mw = s.type === 'sticky' ? STICKY_MIN_W : s.type === 'image' ? IMAGE_MIN_W : s.type === 'text' ? TEXT_MIN_W : ZONE_MIN_W;
        minScaleX = Math.max(minScaleX, mw / s.w);
      }
      if (s.h > 0) {
        const mh = s.type === 'sticky' ? STICKY_MIN_H : s.type === 'image' ? IMAGE_MIN_H : s.type === 'text' ? TEXT_MIN_H : ZONE_MIN_H;
        minScaleY = Math.max(minScaleY, mh / s.h);
      }
    });
    if (!requireMove(seeds.keys())) return;
    settleWheelBeforeInteraction();
    interactionRef.current = { kind: 'drag' };
    dragItemsRef.current = new Set(seeds.keys());
    let finished = false;
    let lastEntries = null;
    // Signs that map a corner's outward direction onto positive growth — using
    // these on raw deltas (not abs) keeps shrink and grow symmetric so the
    // aspect lock holds in both directions.
    void aspect;
    const signX = (corner === 'nw' || corner === 'sw') ? -1 : 1;
    const signY = (corner === 'nw' || corner === 'ne') ? -1 : 1;
    const onMove = (ev) => {
      const z = viewportRef.current.zoom;
      const rawDx = (ev.clientX - start.x) / z;
      const rawDy = (ev.clientY - start.y) / z;
      let sx;
      let sy;
      if (aspectLock) {
        // Drive both axes off whichever scale moved farther from 1, preserving
        // sign so dragging inward shrinks (positive growth → s>1, negative → s<1).
        const candX = (initBBox.w + signX * rawDx) / initBBox.w;
        const candY = (initBBox.h + signY * rawDy) / initBBox.h;
        const s = Math.abs(candX - 1) > Math.abs(candY - 1) ? candX : candY;
        sx = s;
        sy = s;
      } else {
        sx = (initBBox.w + signX * rawDx) / initBBox.w;
        sy = (initBBox.h + signY * rawDy) / initBBox.h;
      }
      // Floor at the per-axis minimum. When locked, raise both to the larger
      // floor so the ratio stays exact.
      const floor = aspectLock ? Math.max(minScaleX, minScaleY) : null;
      sx = aspectLock ? Math.max(sx, floor) : Math.max(sx, minScaleX);
      sy = aspectLock ? Math.max(sy, floor) : Math.max(sy, minScaleY);
      const entries = [];
      seeds.forEach((seed, id) => {
        const patch = {
          x: ax + (seed.x - ax) * sx,
          y: ay + (seed.y - ay) * sy,
        };
        if (seed.w > 0) patch.w = seed.w * sx;
        if (seed.h > 0) patch.h = seed.h * sy;
        entries.push({ id, patch });
      });
      lastEntries = entries;
      commitGeometry(entries);
    };
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      storage.offBusyChange(onBusyChange);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (lastEntries) {
        const entries = lastEntries.map((entry) => ({ id: entry.id, patch: { ...entry.patch } }));
        const patchById = new Map(entries
          .filter((entry) => {
            const it = boardRef.current.items.find((candidate) => candidate.id === entry.id);
            return !(it?.type === 'zone' && it.locked);
          })
          .map((entry) => [entry.id, entry.patch]));
        const finalItems = boardRef.current.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        ));
        // Durable self-orphan: any explicitly-tracked item in the group that
        // resized off its owner must drop it for good (mirrors the solo
        // resize path) — otherwise it silently reattaches later.
        seeds.forEach((seed, id) => {
          const original = originalById.get(id);
          if (!original || !Object.prototype.hasOwnProperty.call(original, 'parentZoneId') || !original.parentZoneId) return;
          const finalSelf = finalItems.find((it) => it.id === id);
          if (!finalSelf) return;
          const owner = finalItems.find((it) => it.id === original.parentZoneId && it.type === 'zone');
          if (!owner || !insideZone(centerOf(finalSelf), owner)) {
            const entry = entries.find((en) => en.id === id);
            if (entry) entry.patch.parentZoneId = null;
            else entries.push({ id, patch: { parentZoneId: null } });
          }
        });
        seeds.forEach((seed, id) => {
          if (seed.type !== 'zone') return;
          const finalZone = finalItems.find((it) => it.id === id);
          if (!finalZone || finalZone.locked) return;
          finalItems.forEach((child) => {
            if (child.parentZoneId === id && !insideZone(centerOf(child), finalZone)) {
              const entry = entries.find((en) => en.id === child.id);
              if (entry) entry.patch.parentZoneId = null;
              else entries.push({ id: child.id, patch: { parentZoneId: null } });
            }
          });
        });
        commitGeometry(entries);
      }
      endGeometry();
      dragItemsRef.current = null;
      storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
    };
    const onBusyChange = () => {
      if (!storage.findRemoteBusyItem(Array.from(seeds.keys()))) return;
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      finalize();
    };
    const onUp = () => finalize();
    const onBlur = () => finalize();
    storage.onBusyChange(onBusyChange);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeGeometryFinalizerRef.current = onBlur;
  }, [
    requireMove, selectedIds, commitGeometry, endGeometry,
    settleWheelBeforeInteraction, startPan,
  ]);

  /* ----- Duplicate selected items (offset clones into board) ----- */
  const duplicateItems = useCallback((sourceItems, offset = 24) => {
    if (!requireEdit() || !sourceItems?.length) return;
    const b = boardRef.current;
    let stripped = 0;
    const idMap = new Map(sourceItems.map((it) => [it.id, uid()]));
    const clones = sourceItems.map((it) => {
      // Don't carry forward text from private cards the user can't see.
      const isHidden = it.type === 'sticky'
        && it.private
        && it.authorId !== userId
        && !effectiveRevealed(it, b.items, b.allRevealed);
      if (isHidden) stripped += 1;
      const clone = {
        ...it,
        id: idMap.get(it.id),
        x: (it.x ?? 0) + offset,
        y: (it.y ?? 0) + offset,
        text: isHidden ? '' : it.text,
        authorId: userId,
        authorName: userName,
        createdAt: Date.now(),
      };
      if (clone.type === 'zone') {
        clone.voteTimer = null;
        clone.lastResultsAt = null;
        clone.votingLocked = false;
      }
      delete clone.zIndex;
      clone.parentZoneId = idMap.has(it.parentZoneId)
        ? idMap.get(it.parentZoneId)
        : (resolveOwnerZone(clone, b.items)?.id ?? null);
      return clone;
    });
    addItemsLocal(clones);
    setSelectedIds(new Set(clones.map((c) => c.id)));
    if (stripped > 0) {
      setToast({ msg: t('copy.hiddenStripped', { n: stripped }), type: 'warn' });
    }
  }, [requireEdit, addItemsLocal, userId, userName]);

  /* ============================================================
     Keyboard
     ============================================================ */
  useEffect(() => {
    const onKey = (e) => {
      if (focusedTextIdRef.current) return;
      if (nameModalOpen) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(
        'input, textarea, select, [contenteditable="true"], '
        + '[role="dialog"], [data-board-shortcuts="off"]',
      )) return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta && e.shiftKey && !e.altKey && e.code === 'Digit1') {
        if (interactionRef.current === null) {
          e.preventDefault();
          fitToContent();
        }
        return;
      }
      if (!meta && e.shiftKey && !e.altKey && e.code === 'Digit2') {
        if (interactionRef.current === null) {
          e.preventDefault();
          fitToSelection();
        }
        return;
      }
      const zoomInKey = e.key === '=' || e.key === '+' || e.code === 'NumpadAdd';
      const zoomOutKey = e.key === '-' || e.code === 'NumpadSubtract';
      const resetZoomKey = e.key === '0' || e.code === 'Numpad0';
      if (meta && (zoomInKey || zoomOutKey || resetZoomKey)) {
        e.preventDefault();
        if (interactionRef.current !== null) return;
        if (zoomInKey) zoomBy(1.2);
        else if (zoomOutKey) zoomBy(1 / 1.2);
        else resetZoom();
        return;
      }
      if (!meta && !e.shiftKey && !e.altKey && (e.key === ']' || e.key === '[')) {
        e.preventDefault();
        if (e.key === ']') bringToFront(selectedIds);
        else sendToBack(selectedIds);
        return;
      }
      if (meta && !e.altKey && (e.key === ']' || e.key === '[')) {
        e.preventDefault();
        const id = selectedIds.size === 1 ? [...selectedIds][0] : null;
        if (e.key === ']') bringForward(id);
        else sendBackward(id);
        return;
      }
      if (e.key === 'Escape') {
        if (creationModeRef.current) { setCreationMode(null); setZonePreview(null); return; }
        setSelectedIds(new Set());
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        deleteItemsIfAllowed(selectedIds);
      }
      // Copy / cut / paste / duplicate / undo / redo selected items.
      if (!meta) return;
      const k = e.key.toLowerCase();
      // Undo: Cmd/Ctrl+Z. Redo: Cmd/Ctrl+Shift+Z or Ctrl+Y.
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); return; }
      if ((k === 'c' || k === 'x') && selectedIds.size > 0) {
        e.preventDefault();
        const picked = boardRef.current.items.filter((it) => selectedIds.has(it.id));
        if (k === 'x' && !deleteItemsIfAllowed(picked.map((it) => it.id))) return;
        clipboardRef.current = picked.map((it) => ({ ...it }));
        setToast({ msg: t('copy.done', { n: picked.length }), type: 'info' });
      }
      if (k === 'v' && clipboardRef.current?.length) {
        e.preventDefault();
        duplicateItems(clipboardRef.current);
      }
      if (k === 'd' && selectedIds.size > 0) {
        e.preventDefault();
        const picked = boardRef.current.items.filter((it) => selectedIds.has(it.id));
        duplicateItems(picked);
      }
      if (k === 'a') {
        e.preventDefault();
        setSelectedIds(new Set(boardRef.current.items.map((it) => it.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    nameModalOpen, selectedIds, deleteItemsIfAllowed, duplicateItems, doUndo, doRedo,
    fitToContent, fitToSelection, zoomBy, resetZoom,
    bringToFront, sendToBack, bringForward, sendBackward,
  ]);

  /* ============================================================
     Image import (paste + drop)
     ============================================================ */
  useEffect(() => {
    const onPaste = async (e) => {
      if (focusedTextIdRef.current) return; // let inputs handle paste
      const items = e.clipboardData?.items || [];
      for (const it of items) {
        if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
          const blob = it.getAsFile();
          if (!blob) continue;
          if (!requireEdit()) return;
          e.preventDefault();
          const rect = canvasRef.current?.getBoundingClientRect();
          const center = rect ? screenToWorld(rect.width / 2, rect.height / 2) : { x: 0, y: 0 };
          await importImageFromBlob(blob, center.x, center.y);
          return;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importImageFromBlob, screenToWorld, requireEdit]);

  const onCanvasDragOver = useCallback((e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  }, []);

  const onCanvasDrop = useCallback(async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    if (!requireEdit()) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    for (const f of e.dataTransfer.files) {
      if (f.type.startsWith('image/')) {
        // eslint-disable-next-line no-await-in-loop
        await importImageFromBlob(f, w.x, w.y);
      }
    }
  }, [importImageFromBlob, requireEdit, screenToWorld]);

  const pickImageFile = useCallback(() => {
    if (!requireEdit()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      const center = rect ? screenToWorld(rect.width / 2, rect.height / 2) : { x: 0, y: 0 };
      await importImageFromBlob(f, center.x, center.y);
    };
    input.click();
  }, [importImageFromBlob, requireEdit, screenToWorld]);

  /* ============================================================
     Live editing: focus textarea, save every keystroke (debounced).
     ============================================================ */
  const canEditItem = useCallback((it) => {
    if (!it) return false;
    if (!editingAllowed && it.authorId !== userId && !isAdmin) return false;
    return true;
  }, [editingAllowed, isAdmin, userId]);

  const beginFocus = useCallback((it, fieldKey = 'text') => {
    if (!canEditItem(it)) {
      setToast({ msg: t('common.warnEditing'), type: 'warn' });
      return;
    }
    setSelectedId(it.id);
    updateFocusedText(`${it.id}:${fieldKey}`);
    setTimeout(() => {
      const el = editAreaRef.current;
      if (el) {
        el.focus();
        // Place cursor at end
        if (typeof el.value === 'string') el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 10);
  }, [canEditItem, setSelectedId, updateFocusedText]);

  const onTextChange = useCallback((id, patch) => {
    updateItem(id, patch);
  }, [updateItem]);

  const onTextBlur = useCallback((id) => {
    if (focusedTextIdRef.current?.startsWith(`${id}:`)) updateFocusedText(null);
    const it = boardRef.current.items.find((i) => i.id === id);
    if (it && (it.type === 'sticky' || it.type === 'text') && !(it.text || '').trim()) {
      deleteItemsIfAllowed([id]);
    }
  }, [deleteItemsIfAllowed, updateFocusedText]);

  const onTextKeyDown = useCallback((e, opts = {}) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && !e.shiftKey && opts.singleLine) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }, []);

  /* ============================================================
     Admin actions
     ============================================================ */
  const adminToggle = useCallback((key) => {
    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
    // patchMeta writes the single flipped flag immediately — no debounce window
    // for applyRemoteBoard to re-spread DEFAULT_BOARD over the local toggle.
    patchMeta({ [key]: !boardRef.current[key] });
  }, [isAdmin, patchMeta]);

  const adminStartTimer = useCallback((zoneId, minutes, voteLimit, hideResults, showNonVoters) => {
    if (!isAdmin) return;
    const items = boardRef.current.items;
    const rootZone = items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!rootZone) return;
    const nowMs = Date.now();
    // Presence-based, not endsAt-based: an expired-but-not-yet-finalized
    // timer still blocks a related start — the natural-expiry reaper hasn't
    // run yet, and letting a new session start in that window lets the
    // reaper's later widened finalize trample it once it does run.
    const isActive = (zone) => !!zone?.voteTimer;
    const descendantZones = [...zoneGroupIds(rootZone, items)]
      .map((id) => items.find((i) => i.id === id))
      .filter((zone) => zone && zone.type === 'zone');
    // A related session must be stopped before this zone can start one.
    let relatedActive = descendantZones.some(isActive);
    if (!relatedActive) {
      let ancestor = effectiveOwnerZone(rootZone, items);
      const visited = new Set();
      while (ancestor && !visited.has(ancestor.id)) {
        if (isActive(ancestor)) {
          relatedActive = true;
          break;
        }
        visited.add(ancestor.id);
        ancestor = effectiveOwnerZone(ancestor, items);
      }
    }
    if (relatedActive) {
      setToast({ msg: t('vote.session.relatedActive'), type: 'warn' });
      return;
    }
    const startedAt = nowMs;
    const endsAt = minutes && minutes > 0 ? startedAt + minutes * 60000 : null;
    const limit = voteLimit && voteLimit > 0 ? voteLimit : null;
    const timerPatch = {
      voteTimer: {
        startedAt, endsAt, voteLimit: limit, hideResults: !!hideResults, showNonVoters: !!showNonVoters,
      },
      lastResultsAt: null,
      votingLocked: false,
    };
    const capturedIds = items
      .filter((item) => item.type === 'sticky')
      .filter((sticky) => {
        const owner = effectiveOwnerZone(sticky, items);
        return !!owner && (owner.id === rootZone.id || isNestedIn(owner, rootZone, items));
      })
      .map((sticky) => sticky.id);
    const staleResultZoneIds = descendantZones
      .filter((zone) => zone.lastResultsAt)
      .map((zone) => zone.id);
    window.storage.startVoteSession(zoneId, timerPatch, staleResultZoneIds, capturedIds);
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => {
        if (it.id === zoneId) return { ...it, ...timerPatch };
        if (staleResultZoneIds.includes(it.id)) return { ...it, lastResultsAt: null };
        return it;
      }),
    }));
    setTimerSetupOpen(false);
    setToast({
      msg: t('vote.session.started', {
        limit: limit ? t('vote.session.votesLimit', { n: limit }) : t('vote.session.unlimited'),
        time: minutes ? t('vote.session.minutes', { n: minutes }) : t('vote.session.noTime'),
      }),
      type: 'info',
    });
  }, [isAdmin, t]);

  const adminExtendTimer = useCallback((zoneId, minutes) => {
    if (!isAdmin) return;
    const zone = boardRef.current.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!zone?.voteTimer) return;
    const cur = zone.voteTimer;
    const base = cur.endsAt && cur.endsAt > Date.now() ? cur.endsAt : Date.now();
    updateItem(zoneId, { voteTimer: { ...cur, endsAt: base + minutes * 60000 } });
  }, [isAdmin, updateItem]);

  const adminStopTimer = useCallback((zoneId) => {
    if (!isAdmin) return;
    const zone = boardRef.current.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!zone?.voteTimer) return;
    finalizeVotingSession(zoneId);
  }, [isAdmin, finalizeVotingSession]);

  const adminClearBoard = useCallback(() => {
    if (!isAdmin) return;
    window.storage?.clearAllVotes?.();
    // Full replace: drop every item, reset session meta, preserve admin identity.
    replaceBoardLocal({
      ...boardRef.current,
      items: [],
      timer: null,
      lastResultsAt: null,
      allRevealed: false,
      votingLocked: false,
      editingLocked: false,
    });
    setConfirmClear(false);
    setTemplatesOpen(true);
  }, [isAdmin, replaceBoardLocal]);

  const adminResetVotes = useCallback(() => {
    if (!isAdmin) return;
    // Votes live in CRDT keys; clearing them re-renders via the vote subscription.
    window.storage?.clearAllVotes?.();
    const zoneEntries = boardRef.current.items
      .filter((i) => i.type === 'zone' && (i.voteTimer || i.lastResultsAt))
      .map((z) => ({ id: z.id, patch: { voteTimer: null, lastResultsAt: null } }));
    if (zoneEntries.length) {
      setBoard((prev) => ({
        ...prev,
        items: prev.items.map((it) => {
          const e = zoneEntries.find((en) => en.id === it.id);
          return e ? { ...it, ...e.patch } : it;
        }),
      }));
      storage.updateItems(zoneEntries);
    }
    patchMeta({ lastResultsAt: null });
    setConfirmResetVotes(false);
    setToast({ msg: t('reset.done'), type: 'info' });
  }, [isAdmin, patchMeta]);

  /* ----- Export / Import ----- */
  const exportBoard = useCallback(() => {
    // Bundle the live board snapshot plus the CRDT-backed vote/template state
    // into a single JSON file. Images are server-hosted (items.src is a URL,
    // not embedded base64) — the file is no longer fully self-contained, and
    // restoring it elsewhere requires the image files to still be reachable
    // at that URL.
    const b = boardRef.current;
    const voteSnap = window.storage?.snapshotVotes?.() || new Map();
    const votes = {};
    voteSnap.forEach((set, itemId) => { votes[itemId] = Array.from(set); });
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      boardCode: boardCode || null,
      board: {
        items: b.items,
        timer: b.timer,
        editingLocked: b.editingLocked,
        votingLocked: b.votingLocked,
        allRevealed: b.allRevealed,
        lastResultsAt: b.lastResultsAt,
      },
      votes,
      customTemplates,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = `retro-${boardCode || 'board'}-${ts}.json`;
    a.href = url;
    a.download = file;
    a.click();
    // Some browsers (Firefox/Safari) start the download asynchronously after
    // `a.click()` returns. Revoking on the same tick can leave the request
    // pointing at a freed blob → empty file. Defer past the current task so
    // the download has time to grab the blob first.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setToast({ msg: t('export.done', { file }), type: 'info' });
  }, [boardCode, customTemplates]);

  // Export only the sticky cards inside one zone as CSV. The all-zones version
  // got swapped out for this per-zone flow — users wanted to grab a single
  // column's output without the rest of the board.
  const exportZoneCsv = useCallback((zone) => {
    if (!zone || zone.type !== 'zone') return;
    const b = boardRef.current;
    const voteSnap = window.storage?.snapshotVotes?.() || new Map();
    const children = b.items
      .filter((i) => i.type === 'sticky' && effectiveOwnerZone(i, b.items)?.id === zone.id)
      .sort((a, c) => (voteSnap.get(c.id)?.size ?? 0) - (voteSnap.get(a.id)?.size ?? 0));
    const lines = [];
    lines.push([
      t('export.csv.text'),
      t('export.csv.author'),
      t('export.csv.votes'),
      t('export.csv.color'),
      t('export.csv.createdAt'),
    ].map(csvEsc).join(','));
    children.forEach((sticky) => {
      const hide = sticky.private && sticky.authorId !== userId
        && !effectiveRevealed(sticky, b.items, b.allRevealed);
      lines.push([
        hide ? t('export.csv.hidden') : (sticky.text || ''),
        sticky.authorName || '',
        voteSnap.get(sticky.id)?.size ?? 0,
        csvColorName(sticky.color ?? 0),
        sticky.createdAt ? new Date(sticky.createdAt).toISOString() : '',
      ].map(csvEsc).join(','));
    });
    const csv = '﻿' + lines.join('\r\n'); // UTF-8 BOM for Excel
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const slug = (zone.title || 'zone').replace(/[^\w฀-๿-]+/g, '_').slice(0, 40) || 'zone';
    const file = `retro-${slug}-${ts}.csv`;
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setToast({ msg: t('export.done', { file }), type: 'info' });
  }, [userId]);

  // Whole-room CSV: every sticky, grouped by zone. Overlapping zones (e.g.
  // Retro Loop's wrapper around Good/Bad/Try) resolve to the smallest
  // enclosing zone, same convention as the timer's auto-sort-by-vote feature.
  // Stickies outside every zone land in a "(no zone)" group.
  const exportBoardCsv = useCallback(() => {
    const b = boardRef.current;
    const voteSnap = window.storage?.snapshotVotes?.() || new Map();
    const zones = b.items.filter((i) => i.type === 'zone');
    const stickies = b.items.filter((i) => i.type === 'sticky');
    const ownerByStickyId = new Map();
    stickies.forEach((s) => {
      const owner = effectiveOwnerZone(s, b.items);
      if (owner) ownerByStickyId.set(s.id, owner.id);
    });
    const noZoneLabel = t('export.csv.unassigned');
    const untitledZoneLabel = t('export.csv.untitledZone');
    const byVotesDesc = (a, c) => (voteSnap.get(c.id)?.size ?? 0) - (voteSnap.get(a.id)?.size ?? 0);
    const lines = [];
    lines.push([
      t('export.csv.zone'),
      t('export.csv.text'),
      t('export.csv.author'),
      t('export.csv.votes'),
      t('export.csv.color'),
      t('export.csv.createdAt'),
    ].map(csvEsc).join(','));
    const pushRow = (zoneLabel, sticky) => {
      const hide = sticky.private && sticky.authorId !== userId
        && !effectiveRevealed(sticky, b.items, b.allRevealed);
      lines.push([
        zoneLabel,
        hide ? t('export.csv.hidden') : (sticky.text || ''),
        sticky.authorName || '',
        voteSnap.get(sticky.id)?.size ?? 0,
        csvColorName(sticky.color ?? 0),
        sticky.createdAt ? new Date(sticky.createdAt).toISOString() : '',
      ].map(csvEsc).join(','));
    };
    // Contiguous blocks, one per zone (in board order), then a final
    // "(no zone)" block — not a global vote sort, so the CSV reads like the
    // board's own columns instead of interleaving zones by vote count.
    zones.forEach((zone) => {
      stickies
        .filter((s) => ownerByStickyId.get(s.id) === zone.id)
        .sort(byVotesDesc)
        .forEach((sticky) => pushRow(zone.title || untitledZoneLabel, sticky));
    });
    stickies
      .filter((s) => !ownerByStickyId.has(s.id))
      .sort(byVotesDesc)
      .forEach((sticky) => pushRow(noZoneLabel, sticky));
    const csv = '﻿' + lines.join('\r\n'); // UTF-8 BOM for Excel
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const file = `retro-${boardCode || 'board'}-${ts}.csv`;
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setToast({ msg: t('export.done', { file }), type: 'info' });
  }, [boardCode, userId]);

  const fileInputRef = useRef(null);
  const [pendingImport, setPendingImport] = useState(null); // { file, parsed }
  const [importBusy, setImportBusy] = useState(false); // sanitizing legacy images before write
  const [helpOpen, setHelpOpen] = useState(false);

  const onImportPick = useCallback(() => {
    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
    fileInputRef.current?.click();
  }, [isAdmin]);

  const onImportFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed?.board?.items || !Array.isArray(parsed.board.items)) {
        throw new Error('missing board.items');
      }
      const importedAt = Date.now();
      const zLimit = Number.MAX_SAFE_INTEGER - parsed.board.items.length - 1;
      parsed.board.items = parsed.board.items.map((item, index) => {
        const normalized = { ...item };
        normalized.createdAt = Number.isFinite(item?.createdAt)
          && Math.abs(item.createdAt) <= zLimit
          ? item.createdAt
          : importedAt + index;
        if (!Number.isFinite(item?.zIndex) || Math.abs(item.zIndex) > zLimit) {
          delete normalized.zIndex;
        }
        return normalized;
      });
      setPendingImport({ name: file.name, parsed });
    } catch (err) {
      setToast({ msg: t('import.fail', { err: err.message }), type: 'warn' });
    }
  }, []);

  const confirmImport = useCallback(async () => {
    if (!pendingImport || !isAdmin || importBusy) return;
    const { parsed } = pendingImport;
    const rawItems = parsed.board.items.map((item) => (
      item.type === 'zone'
        ? { ...item, voteTimer: null, lastResultsAt: null, votingLocked: false }
        : item
    ));
    setImportBusy(true);
    let importedItems;
    let skippedImages;
    try {
      const sanitized = await sanitizeImportedImages(rawItems);
      importedItems = sanitized.items;
      skippedImages = sanitized.skipped;
    } catch (err) {
      setImportBusy(false);
      setToast({ msg: t('import.fail', { err: err.message }), type: 'warn' });
      return;
    }
    const snapshotBytes = new TextEncoder().encode(JSON.stringify(importedItems)).length;
    if (snapshotBytes > IMPORT_MAX_SNAPSHOT_BYTES) {
      setImportBusy(false);
      setToast({
        msg: t('import.tooLarge', { mb: (IMPORT_MAX_SNAPSHOT_BYTES / 1024 / 1024).toFixed(1) }),
        type: 'warn',
      });
      return;
    }
    // Wipe vote keys first — incoming userIds reference the source room.
    window.storage?.clearAllVotes?.();
    // Restore board fields (drop unrelated keys to avoid sneaking in bad shape).
    // Full replace so removed items are deleted from Yjs, not just hidden.
    replaceBoardLocal({
      ...DEFAULT_BOARD,
      items: importedItems,
      timer: parsed.board.timer || null,
      editingLocked: !!parsed.board.editingLocked,
      // Older exports predate votingLocked; default to unlocked when absent.
      votingLocked: parsed.board.votingLocked ?? false,
      allRevealed: !!parsed.board.allRevealed,
      lastResultsAt: parsed.board.lastResultsAt || null,
      // Preserve identity-of-the-room across import: who's admin, what their
      // display name is, and the PIN gate. Otherwise an admin importing a
      // backup would silently wipe their own PIN and re-prompt to set a new
      // one on the next destructive action.
      adminUserId: boardRef.current.adminUserId,
      adminName: boardRef.current.adminName,
      adminPinHash: boardRef.current.adminPinHash,
    });
    // Replay votes — each (itemId, userId) pair becomes its own CRDT key so
    // they survive concurrent edits in the destination room.
    if (parsed.votes && typeof parsed.votes === 'object') {
      Object.entries(parsed.votes).forEach(([itemId, voters]) => {
        if (!Array.isArray(voters)) return;
        voters.forEach((u) => window.storage?.setVote?.(itemId, u, true));
      });
    }
    if (Array.isArray(parsed.customTemplates)) {
      setCustomTemplates(parsed.customTemplates);
      storage.set('customTemplates', parsed.customTemplates, true);
    }
    const n = parsed.board.items.length;
    setPendingImport(null);
    setImportBusy(false);
    setToast({
      msg: skippedImages
        ? t('import.doneWithSkipped', { n, skipped: skippedImages })
        : t('import.done', { n }),
      type: 'info',
    });
  }, [pendingImport, isAdmin, importBusy, replaceBoardLocal]);

  /* ============================================================
     Rendering helpers
     ============================================================ */

  const renderZone = (it) => (
    <ZoneCard
      key={it.id}
      item={it}
      selected={selectedIds.has(it.id)}
      isEditingTitle={focusedTextId === `${it.id}:title`}
      childCount={zoneChildCount.get(it.id) || 0}
      lang={lang}
      onStartZoneDrag={startZoneDrag}
      onBeginFocus={beginFocus}
      onTextChange={onTextChange}
      onTextKeyDown={onTextKeyDown}
      onTextBlur={onTextBlur}
      editAreaRef={editAreaRef}
    />
  );

  const renderText = (it) => (
    <TextCard
      key={it.id}
      item={it}
      selected={selectedIds.has(it.id)}
      isEditing={focusedTextId === `${it.id}:text`}
      lang={lang}
      onStartDrag={startItemDrag}
      onBeginFocus={beginFocus}
      onTextChange={onTextChange}
      onTextKeyDown={onTextKeyDown}
      onTextBlur={onTextBlur}
      editAreaRef={editAreaRef}
    />
  );

  const renderSticky = (it) => (
    <StickyCard
      key={it.id}
      item={it}
      selected={selectedIds.has(it.id)}
      isEditing={focusedTextId === `${it.id}:text`}
      isOwner={it.authorId === userId}
      allRevealed={stickyVotingContext.get(it.id)?.revealed ?? board.allRevealed}
      dense={denseRender}
      voted={didUserVoteOn(it.id)}
      voteCount={voteCountOf(it.id)}
      voteFlash={voteFlashes[it.id] || null}
      voteRank={topVotedRanks.get(it.id)}
      votingAllowedNow={stickyVotingContext.get(it.id)?.votingAllowedNow ?? false}
      showVoteCount={!(stickyVotingContext.get(it.id)?.hideVoteCounts ?? false)}
      inZone={stickyVotingContext.get(it.id)?.inZone ?? false}
      lang={lang}
      onStartDrag={startItemDrag}
      onBeginFocus={beginFocus}
      onTextChange={onTextChange}
      onTextKeyDown={onTextKeyDown}
      onTextBlur={onTextBlur}
      onToggleVote={toggleVote}
      editAreaRef={editAreaRef}
    />
  );

  /* ============================================================
     Action toolbar (screen space, above selected item)
     ============================================================ */
  const selectedItem = useMemo(
    () => board.items.find((i) => i.id === selectedId) || null,
    [board.items, selectedId],
  );

  // Union bounding box of multi-selection (used for group move/resize handles).
  const groupBBox = useMemo(() => {
    if (selectedIds.size < 2) return null;
    const items = board.items.filter((it) => selectedIds.has(it.id));
    if (!items.length) return null;
    let minX = Infinity; let minY = Infinity;
    let maxX = -Infinity; let maxY = -Infinity;
    items.forEach((it) => {
      const w = it.w || (it.type === 'sticky' ? STICKY_W : it.type === 'image' ? 200 : it.type === 'text' ? TEXT_W : 0);
      const h = it.h || (it.type === 'sticky' ? STICKY_H : it.type === 'image' ? 200 : it.type === 'text' ? TEXT_H : 0);
      if (it.x < minX) minX = it.x;
      if (it.y < minY) minY = it.y;
      if (it.x + w > maxX) maxX = it.x + w;
      if (it.y + h > maxY) maxY = it.y + h;
    });
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }, [board.items, selectedIds]);

  const renderImage = (it) => (
    <ImageCard
      key={it.id}
      item={it}
      selected={selectedIds.has(it.id)}
      dense={denseRender}
      onStartDrag={startItemDrag}
    />
  );

  // Memoize the rendered children list so pan/zoom (which only touch viewport)
  // don't rebuild the JSX tree for every card. Deps cover everything renderXxx
  // closes over; if none of those change, React reuses the same element array
  // and skips reconciliation entirely for the cards.
  const renderedItems = useMemo(
    () => visibleItems.map((it) => {
      if (it.type === 'image') return renderImage(it);
      if (it.type === 'zone') return renderZone(it);
      if (it.type === 'text') return renderText(it);
      return renderSticky(it);
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      visibleItems,
      selectedIds,
      focusedTextId,
      votesByItem,
      voteFlashes,
      topVotedRanks,
      stickyVotingContext,
      userId,
      denseRender,
      lang,
      zoneChildCount,
      startItemDrag,
      startZoneDrag,
      beginFocus,
      onTextChange,
      onTextKeyDown,
      onTextBlur,
      toggleVote,
    ],
  );

  const renderActionToolbar = () => {
    if (!selectedItem || focusedTextId) return null;
    if (selectedIds.size > 1) return null;
    const v = viewportRef.current;
    let sx;
    let sy;
    if (selectedItem.type === 'zone') {
      sx = selectedItem.x * v.zoom + v.x + (selectedItem.w * v.zoom) / 2;
      sy = selectedItem.y * v.zoom + v.y - ZONE_TITLE_H * v.zoom - 14;
    } else if (selectedItem.type === 'sticky' || selectedItem.type === 'image') {
      const iw = selectedItem.w || (selectedItem.type === 'sticky' ? STICKY_W : 200);
      sx = selectedItem.x * v.zoom + v.x + (iw * v.zoom) / 2;
      sy = selectedItem.y * v.zoom + v.y - 14;
    } else {
      sx = selectedItem.x * v.zoom + v.x + 60;
      sy = selectedItem.y * v.zoom + v.y - 14;
    }
    const can = canModifyOwnedItem(selectedItem);
    const canDelete = canDeleteItem(selectedItem);
    const nestedZoneCount = selectedItem.type === 'zone'
      ? [...zoneGroupIds(selectedItem, board.items)].filter((id) => (
          id !== selectedItem.id
          && board.items.find((item) => item.id === id)?.type === 'zone'
        )).length
      : 0;
    return (
      <div
        style={{
          position: 'fixed',
          left: sx,
          top: sy,
          transform: 'translate(-50%, -100%)',
          background: 'var(--bg-panel)',
          borderRadius: 10,
          boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
          padding: '6px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          zIndex: 30,
          pointerEvents: 'auto',
          animation: 'rb-pop 0.18s ease-out',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(selectedItem.type === 'sticky' || selectedItem.type === 'zone') && (
          <div style={{ display: 'flex', gap: 4 }}>
            {COLORS.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => can && updateItem(selectedItem.id, { color: i })}
                disabled={!can}
                aria-label={`color-${i}`}
                style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: c.bg, border: `2px solid ${selectedItem.color === i ? '#1f2937' : c.border}`,
                  cursor: can ? 'pointer' : 'not-allowed', padding: 0,
                }}
              />
            ))}
          </div>
        )}
        {(selectedItem.type === 'sticky' || selectedItem.type === 'zone' || selectedItem.type === 'text') && (
          (() => {
            const defaultFs = selectedItem.type === 'text' ? 40 : selectedItem.type === 'zone' ? 14 : 15;
            const fs = selectedItem.fontSize || defaultFs;
            const setFs = (next) => can && updateItem(selectedItem.id, { fontSize: Math.max(10, Math.min(96, next)) });
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, borderLeft: '1px solid var(--border-soft)', paddingLeft: 6, marginLeft: 2 }}>
                <button
                  type="button"
                  onClick={() => setFs(fs - 2)}
                  disabled={!can || fs <= 10}
                  title={t('font.decrease')}
                  style={{ ...iconBtn(can && fs > 10), fontWeight: 700, fontSize: 12 }}
                >A−</button>
                <span style={{
                  minWidth: 24, textAlign: 'center', fontSize: 11,
                  color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums',
                }}
                >{fs}</span>
                <button
                  type="button"
                  onClick={() => setFs(fs + 2)}
                  disabled={!can || fs >= 96}
                  title={t('font.increase')}
                  style={{ ...iconBtn(can && fs < 96), fontWeight: 700, fontSize: 15 }}
                >A+</button>
              </div>
            );
          })()
        )}
        {(selectedItem.type === 'sticky' || selectedItem.type === 'text') && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => can && setFontColorOpen((o) => !o)}
              disabled={!can}
              title={t('font.color')}
              style={iconBtn(can)}
            >
              <Type size={15} style={{
                color: selectedItem.fontColor || 'currentColor',
                // Outline so white/light swatches stay visible against the toolbar.
                filter: selectedItem.fontColor === '#ffffff'
                  ? 'drop-shadow(0 0 1px var(--text-mid))' : 'none',
              }}
              />
            </button>
            {fontColorOpen && (
              <>
                <div
                  onMouseDown={() => setFontColorOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 31 }}
                />
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute', top: '100%', left: '50%',
                    transform: 'translateX(-50%)', marginTop: 6,
                    background: 'var(--bg-panel)', borderRadius: 10,
                    boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
                    padding: 8, display: 'grid',
                    gridTemplateColumns: 'repeat(5, 22px)',
                    gap: 6, zIndex: 32,
                  }}
                >
                  {FONT_COLORS.map((fc) => {
                    const active = (selectedItem.fontColor ?? null) === fc.value;
                    return (
                      <button
                        key={fc.label}
                        type="button"
                        onClick={() => {
                          updateItem(selectedItem.id, { fontColor: fc.value });
                          setFontColorOpen(false);
                        }}
                        title={fc.label}
                        style={{
                          width: 22, height: 22, borderRadius: '50%',
                          background: fc.swatch,
                          border: active
                            ? '2px solid var(--accent)'
                            : '1px solid var(--border)',
                          cursor: 'pointer', padding: 0,
                        }}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
        {selectedItem.type === 'sticky' && (
          <button
            type="button"
            onClick={() => can && updateItem(selectedItem.id, { private: !selectedItem.private })}
            disabled={!can}
            title={selectedItem.private ? t('sticky.privacyToggle.off') : t('sticky.privacyToggle.on')}
            style={iconBtn(can)}
          >
            {selectedItem.private ? <Lock size={15} /> : <Unlock size={15} />}
          </button>
        )}
        {selectedItem.type === 'zone' && (
          <button
            type="button"
            onClick={() => can && updateItem(selectedItem.id, { locked: !selectedItem.locked })}
            disabled={!can}
            title={selectedItem.locked ? t('zone.lockToggle.off') : t('zone.lockToggle.on')}
            style={iconBtn(can)}
          >
            {selectedItem.locked ? <Lock size={15} /> : <Unlock size={15} />}
          </button>
        )}
        {selectedItem.type === 'zone' && (
          <button
            type="button"
            onClick={() => exportZoneCsv(selectedItem)}
            title={t('zone.exportCsvTitle')}
            style={iconBtn(true)}
          >
            <Download size={15} />
          </button>
        )}
        {selectedItem.type === 'zone' && isAdmin && (
          <button
            type="button"
            onClick={() => updateItem(selectedItem.id, { votingLocked: !selectedItem.votingLocked })}
            disabled={!selectedItem.voteTimer}
            title={selectedItem.votingLocked ? t('zone.unlockVote') : t('zone.lockVote')}
            style={iconBtn(!!selectedItem.voteTimer)}
          >
            {selectedItem.votingLocked ? <Ban size={15} /> : <ThumbsUp size={15} />}
          </button>
        )}
        {selectedItem.type === 'zone' && isAdmin && (
          <button
            type="button"
            onClick={() => updateItem(selectedItem.id, { revealed: !selectedItem.revealed })}
            title={selectedItem.revealed ? t('zone.hideCards') : t('zone.revealCards')}
            style={iconBtn(true)}
          >
            {selectedItem.revealed ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
        {selectedItem.type === 'zone' && isAdmin && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => {
                if (selectedItem.voteTimer) { adminStopTimer(selectedItem.id); }
                else { setTimerSetupOpen((v) => !v); }
              }}
              title={selectedItem.voteTimer ? t('topbar.stopVote') : t('zone.startVote')}
              style={iconBtn(true)}
            >
              {selectedItem.voteTimer ? <Square size={15} /> : <ThumbsUp size={15} />}
            </button>
            {timerSetupOpen && (
              <TimerSetup
                onClose={() => setTimerSetupOpen(false)}
                onStart={(m, v, h, s) => adminStartTimer(selectedItem.id, m, v, h, s)}
                nestedZoneCount={nestedZoneCount}
              />
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => can && bringToFront(new Set([selectedItem.id]))}
          disabled={!can}
          title="Bring to front"
          style={iconBtn(can)}
        >
          <BringToFront size={15} />
        </button>
        <button
          type="button"
          onClick={() => can && sendToBack(new Set([selectedItem.id]))}
          disabled={!can}
          title="Send to back"
          style={iconBtn(can)}
        >
          <SendToBack size={15} />
        </button>
        <button
          type="button"
          onClick={() => deleteItemsIfAllowed([selectedItem.id])}
          disabled={!canDelete}
          title={selectedItem.locked ? t('zone.lockedDeleteTitle') : t('common.delete')}
          style={{ ...iconBtn(canDelete), color: canDelete ? '#ef4444' : 'var(--border)' }}
        >
          <Trash2 size={15} />
        </button>
      </div>
    );
  };

  const renderResizeHandles = () => {
    if (focusedTextId) return null;
    const v = viewportRef.current;

    // Group selection: draw bbox outline + corner handles that scale all items.
    if (groupBBox && selectedIds.size > 1) {
      const { x, y, w, h } = groupBBox;
      const corners = [
        { k: 'nw', sx: x,     sy: y,     cursor: 'nwse-resize' },
        { k: 'ne', sx: x + w, sy: y,     cursor: 'nesw-resize' },
        { k: 'sw', sx: x,     sy: y + h, cursor: 'nesw-resize' },
        { k: 'se', sx: x + w, sy: y + h, cursor: 'nwse-resize' },
      ];
      return (
        <>
          <div
            style={{
              position: 'fixed',
              left: x * v.zoom + v.x,
              top: y * v.zoom + v.y,
              width: w * v.zoom,
              height: h * v.zoom,
              border: '2px dashed #2563eb',
              borderRadius: 4,
              pointerEvents: 'none',
              zIndex: 24,
            }}
          />
          {corners.map((c) => (
            <div
              key={c.k}
              onMouseDown={(e) => startGroupResize(e, c.k)}
              style={{
                position: 'fixed',
                left: c.sx * v.zoom + v.x - 7,
                top: c.sy * v.zoom + v.y - 7,
                width: 14,
                height: 14,
                background: 'var(--bg-panel)',
                border: '2px solid #2563eb',
                borderRadius: '50%',
                cursor: c.cursor,
                zIndex: 25,
              }}
            />
          ))}
        </>
      );
    }

    if (!selectedItem) return null;
    if (selectedItem.type === 'zone' && selectedItem.locked) return null;
    const resizable = selectedItem.type === 'zone' || selectedItem.type === 'sticky' || selectedItem.type === 'image' || selectedItem.type === 'text';
    if (!resizable) return null;
    const w = selectedItem.w || (selectedItem.type === 'sticky' ? STICKY_W : selectedItem.type === 'text' ? TEXT_W : 200);
    const h = selectedItem.h || (selectedItem.type === 'sticky' ? STICKY_H : selectedItem.type === 'text' ? TEXT_H : 200);
    const corners = [
      { k: 'nw', sx: selectedItem.x,     sy: selectedItem.y,     cursor: 'nwse-resize' },
      { k: 'ne', sx: selectedItem.x + w, sy: selectedItem.y,     cursor: 'nesw-resize' },
      { k: 'sw', sx: selectedItem.x,     sy: selectedItem.y + h, cursor: 'nesw-resize' },
      { k: 'se', sx: selectedItem.x + w, sy: selectedItem.y + h, cursor: 'nwse-resize' },
    ];
    return corners.map((c) => (
      <div
        key={c.k}
        onMouseDown={(e) => startItemResize(e, selectedItem, c.k)}
        style={{
          position: 'fixed',
          left: c.sx * v.zoom + v.x - 7,
          top: c.sy * v.zoom + v.y - 7,
          width: 14,
          height: 14,
          background: 'var(--bg-panel)',
          border: '2px solid #2563eb',
          borderRadius: '50%',
          cursor: c.cursor,
          zIndex: 25,
        }}
      />
    ));
  };

  /* ============================================================
     Top bar / floating UI
     ============================================================ */
  const renderTopBar = () => {
    const ThemeIcon = themePref === 'auto' ? Monitor : themePref === 'dark' ? Moon : Sun;
    return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 60,
        background: 'var(--bg-overlay)', backdropFilter: 'blur(8px)',
        borderBottom: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px',
        zIndex: 50,
      }}
    >
      <button
        type="button"
        onClick={() => { window.location.href = '/'; }}
        title={t('topbar.home')}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          padding: '4px 8px', borderRadius: 8, color: 'var(--text)',
          display: 'flex', alignItems: 'center', gap: 6,
          fontWeight: 800, fontSize: 18,
        }}
      >
        <Sparkles size={18} color="var(--accent)" /> {t('app.title')}
      </button>
      {boardCode && (
        <button
          type="button"
          onClick={() => {
            // Share URL must include the token in the #fragment so joiners
            // land on the same yjs doc. Without it they'd get a sibling
            // tokenless board with the same code prefix.
            const shareUrl = `${window.location.origin}/b/${boardCode}${boardToken ? `#${boardToken}` : ''}`;
            try {
              navigator.clipboard.writeText(shareUrl);
              setToast({ msg: t('topbar.copied'), type: 'info' });
            } catch {
              setToast({ msg: t('topbar.shareLink', { code: boardCode }), type: 'info' });
            }
          }}
          title={t('topbar.copyLink')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--bg-panel-2)', border: '1px solid #e5e7eb',
            borderRadius: 999, padding: '4px 10px',
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            fontSize: 12, fontWeight: 700, color: 'var(--accent)',
            cursor: 'pointer',
          }}
        >
          <Copy size={12} /> {boardCode}
        </button>
      )}

      <div style={{ flex: 1 }} />

      {/* Admin controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <TopBtn
          title={t('topbar.undo')}
          onClick={doUndo}
          enabled={undoState.canUndo}
          disabledHint={t('topbar.nothingToUndo')}
          icon={<Undo2 size={16} />}
        />
        <TopBtn
          title={t('topbar.redo')}
          onClick={doRedo}
          enabled={undoState.canRedo}
          disabledHint={t('topbar.nothingToRedo')}
          icon={<Redo2 size={16} />}
        />
        <TopBarDivider />
        <TopBtn
          title={board.editingLocked ? 'Editing locked' : 'Lock editing'}
          onClick={() => adminToggle('editingLocked')}
          active={board.editingLocked}
          enabled={isAdmin}
          icon={board.editingLocked ? <Lock size={16} /> : <Unlock size={16} />}
          label={board.editingLocked ? t('topbar.unlockEdit') : t('topbar.lockEdit')}
        />
        <TopBarDivider />
        {/* Hidden file input — opened via the More menu's Import action. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={onImportFileChange}
          style={{ display: 'none' }}
        />
        {/* Consolidated overflow menu — keeps file I/O + destructive +
            admin-transfer out of the always-visible cluster. */}
        <div style={{ position: 'relative' }}>
          <TopBtn
            title={t('topbar.more') || 'More'}
            onClick={() => setMoreMenuOpen((v) => !v)}
            enabled
            icon={<MoreHorizontal size={16} />}
          />
          {moreMenuOpen && (
            <>
              <div
                onClick={() => setMoreMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 59 }}
              />
              <div
                style={{
                  position: 'absolute', top: '110%', right: 0,
                  background: 'var(--bg-elev)', borderRadius: 10,
                  boxShadow: 'var(--shadow-pop)',
                  padding: 6, marginTop: 6, minWidth: 220, zIndex: 60,
                  animation: 'rb-pop 0.18s ease-out',
                }}
              >
                <MoreMenuItem
                  icon={<ZoomIn size={15} />}
                  label={t('settings.scrollWheelZoom')}
                  checked={scrollWheelZoomEnabled}
                  onClick={toggleScrollWheelZoom}
                />
                <MoreMenuDivider />
                <MoreMenuItem
                  icon={<Download size={15} />}
                  label={t('topbar.export')}
                  onClick={() => { setMoreMenuOpen(false); exportBoard(); }}
                />
                <MoreMenuItem
                  icon={<Download size={15} />}
                  label={t('topbar.exportCsv')}
                  onClick={() => { setMoreMenuOpen(false); exportBoardCsv(); }}
                />
                <MoreMenuItem
                  icon={<Upload size={15} />}
                  label={t('topbar.import')}
                  disabled={!isAdmin}
                  onClick={() => {
                    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
                    setMoreMenuOpen(false);
                    onImportPick();
                  }}
                />
                <MoreMenuItem
                  icon={<HelpCircle size={15} />}
                  label={t('help.menuLabel')}
                  onClick={() => { setMoreMenuOpen(false); setHelpOpen(true); }}
                />
                <MoreMenuDivider />
                <MoreMenuItem
                  icon={<RotateCcw size={15} />}
                  label={t('topbar.resetVotes')}
                  disabled={!isAdmin}
                  danger
                  onClick={() => {
                    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
                    setMoreMenuOpen(false);
                    setConfirmResetVotes(true);
                  }}
                />
                <MoreMenuItem
                  icon={<Trash2 size={15} />}
                  label={t('topbar.clear')}
                  disabled={!isAdmin}
                  danger
                  onClick={() => {
                    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
                    setMoreMenuOpen(false);
                    setConfirmClear(true);
                  }}
                />
                <MoreMenuDivider />
                <MoreMenuItem
                  icon={<Crown size={15} />}
                  label={t('topbar.transfer')}
                  disabled={!isAdmin}
                  onClick={() => {
                    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
                    setMoreMenuOpen(false);
                    setTransferOpen(true);
                  }}
                />
              </div>
            </>
          )}
          {transferOpen && isAdmin && (
            <>
              <div
                onClick={() => setTransferOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 59 }}
              />
              <div
                data-board-shortcuts="off"
                style={{
                  position: 'absolute', top: '110%', right: 0,
                  background: 'var(--bg-panel)', borderRadius: 10,
                  boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
                  padding: 8, marginTop: 6, minWidth: 200, zIndex: 60,
                  animation: 'rb-pop 0.18s ease-out',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}>{t('transfer.list.title')}</div>
                {onlineUsers.filter((u) => u.userId !== userId).length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: 8 }}>{t('transfer.list.empty')}</div>
                )}
                {onlineUsers.filter((u) => u.userId !== userId).map((u) => (
                  <button
                    key={u.userId}
                    type="button"
                    onClick={() => { setTransferOpen(false); requireAdminPin(() => adminTransfer(u.userId)); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      width: '100%', textAlign: 'left',
                      background: 'transparent', border: 'none',
                      padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                    }}
                    onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-panel-2)'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Avatar id={u.userId} name={u.name} />
                    <span style={{ fontSize: 13 }}>{u.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Current-admin pill — visible to every user so non-admins can tell
          at a glance who's running the board (the crown on the avatar is
          only 9px, easy to miss). Always renders when an adminUserId is
          set; falls back through presence → yMeta-cached name → localized
          generic so the pill stays visible even before awareness sync. */}
      {board.adminUserId && (() => {
        const isOnline = onlineUsers.some((u) => u.userId === board.adminUserId);
        const adminName = presence[board.adminUserId]?.name
          || board.adminName
          || t('common.admin');
        return (
          <div
            title={t('common.admin')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 999,
              background: 'var(--warn-bg)', color: 'var(--warn-text)',
              fontSize: 12, fontWeight: 700,
              border: '1px solid var(--warn-text)',
              marginLeft: 4,
              opacity: isOnline ? 1 : 0.55,
            }}
          >
            <Crown size={12} />
            <span>{adminName}{isAdmin ? ` ${t('common.you')}` : ''}</span>
          </div>
        );
      })()}

      {/* Claim-admin button — visible when no admin is active (no adminUserId
          set OR the recorded admin hasn't been seen for a while) and the
          current user isn't already admin. Anyone holding the PIN can take
          over a vacant role, which is the one recovery path for a board
          whose creator lost their localStorage. */}
      {canClaim && (
        <button
          type="button"
          onClick={adminClaim}
          title={t('admin.claim.title')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: 'var(--accent)', color: '#fff',
            fontSize: 12, fontWeight: 700,
            border: 'none', cursor: 'pointer',
            marginLeft: 4,
          }}
        >
          <Crown size={12} />
          <span>{t('admin.claim')}</span>
        </button>
      )}

      {/* Presence avatars — click to open player list */}
      <div style={{ position: 'relative', paddingLeft: 6, borderLeft: '1px solid var(--border-soft)', marginLeft: 4 }}>
        <button
          type="button"
          onClick={() => setPlayerListOpen((v) => !v)}
          title={t('topbar.playersTitle', { n: onlineUsers.length })}
          style={{
            display: 'flex', alignItems: 'center', gap: -8,
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '2px 4px', borderRadius: 999,
          }}
          onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-panel-2)'; }}
          onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {onlineUsers.slice(0, 6).map((u) => (
            <div key={u.userId} style={{ marginLeft: -8 }}>
              <Avatar id={u.userId} name={u.name} crown={u.userId === board.adminUserId} ring />
            </div>
          ))}
          {onlineUsers.length > 6 && (
            <div style={{ marginLeft: 4, fontSize: 12, color: 'var(--text-muted)' }}>+{onlineUsers.length - 6}</div>
          )}
        </button>
        {playerListOpen && (
          <>
            {/* click-outside backdrop */}
            <div
              onClick={() => setPlayerListOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 59 }}
            />
            <div
              style={{
                position: 'absolute', top: '110%', right: 0,
                background: 'var(--bg-elev)', borderRadius: 10,
                boxShadow: 'var(--shadow-pop)',
                padding: 8, marginTop: 6, minWidth: 220, zIndex: 60,
                animation: 'rb-pop 0.18s ease-out',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}>
                {t('players.head', { n: onlineUsers.length })}
              </div>
              {onlineUsers.map((u) => {
                const isMe = u.userId === userId;
                const isUserAdmin = u.userId === board.adminUserId;
                const used = votesUsedByUser.get(u.userId) || 0;
                // Concurrent zone sessions can carry different vote limits — use
                // the strictest active one so "full" doesn't under-warn.
                const limit = activeZoneVoteLimit;
                const isFull = limit != null && used >= limit;
                return (
                  <div
                    key={u.userId}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 8px', borderRadius: 6,
                    }}
                  >
                    <Avatar id={u.userId} name={u.name} crown={isUserAdmin} />
                    <span style={{ fontSize: 13, flex: 1 }}>
                      {u.name}
                      {isMe && <span style={{ color: 'var(--text-faint)', marginLeft: 4 }}>{t('common.you')}</span>}
                    </span>
                    <span
                      title={t('players.votesTooltip')}
                      style={{
                        fontSize: 11, fontVariantNumeric: 'tabular-nums',
                        color: isFull ? 'var(--ok-text, #047857)' : 'var(--text-muted)',
                        background: isFull ? 'var(--ok-bg, #d1fae5)' : 'var(--bg-panel-2)',
                        padding: '2px 6px', borderRadius: 999, fontWeight: 600,
                      }}
                    >
                      {limit != null ? `${used}/${limit}` : `${used}`}
                    </span>
                    {isUserAdmin && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, color: 'var(--warn-text)',
                        background: 'var(--warn-bg)', padding: '2px 6px', borderRadius: 999,
                      }}
                      >{t('common.admin')}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => { setNameDraft(userName); setNameModalOpen(true); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: '1px solid var(--border-strong)',
          padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
          fontSize: 13, color: 'var(--text-mid)',
        }}
        title={t('topbar.editName')}
      >
        <Avatar id={userId || ''} name={userName} crown={isAdmin} small />
        <span>{userName || t('topbar.setName')}</span>
      </button>

      {/* Lang + theme toggles */}
      <button
        type="button"
        onClick={() => setLang(lang === 'th' ? 'en' : 'th')}
        title={t('settings.lang')}
        style={{
          background: 'transparent', border: '1px solid var(--border-strong)',
          padding: '4px 8px', borderRadius: 999, cursor: 'pointer',
          fontSize: 12, fontWeight: 700, color: 'var(--text)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}
      >
        <Languages size={14} /> {lang === 'th' ? 'TH' : 'EN'}
      </button>
      <button
        type="button"
        onClick={() => setThemePref(nextThemePref(themePref))}
        title={`${t('settings.theme')}: ${t(`settings.theme.${themePref}`)}`}
        style={{
          background: 'transparent', border: '1px solid var(--border-strong)',
          padding: '4px 8px', borderRadius: 999, cursor: 'pointer',
          fontSize: 12, color: 'var(--text)',
          display: 'inline-flex', alignItems: 'center',
        }}
      >
        <ThemeIcon size={14} />
      </button>
    </div>
    );
  };

  const renderTimerDockFor = (zone) => {
    const zTimer = zone.voteTimer;
    const remainingMs = zTimer.endsAt ? zTimer.endsAt - now : null;
    const isUrgent = remainingMs != null && remainingMs < 30000;
    // used/limit, ascending — matches the players-list badge's semantics
    // (votesUsedByUser), so the same "X/Y" shape means the same thing
    // everywhere instead of counting up in one place and down in another.
    return (
      <div
        key={zone.id}
        style={{
          background: 'var(--bg-elev)',
          color: 'var(--text)',
          border: '1px solid var(--border-soft)',
          padding: '8px 12px', borderRadius: 14,
          display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 12px 30px rgba(0,0,0,0.18)',
          animation: isUrgent
            ? 'rb-banner-in 0.35s cubic-bezier(.2,1,.3,1) both, rb-pulse 1s ease-in-out infinite'
            : 'rb-banner-in 0.35s cubic-bezier(.2,1,.3,1) both',
          backdropFilter: 'blur(8px)',
        }}
      >
        <span
          style={{
            maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: 12, fontWeight: 700, color: 'var(--text-mid)',
          }}
        >
          {zone.title || t('export.csv.untitledZone')}
        </span>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            color: isUrgent ? '#dc2626' : 'var(--text)',
            padding: '0 6px',
          }}
        >
          {remainingMs != null ? <Clock size={18} /> : <ThumbsUp size={18} />}
          <span style={{ fontFamily: 'tabular-nums', fontSize: 22, fontWeight: 700, minWidth: 56, textAlign: 'center' }}>
            {remainingMs != null ? fmtClock(remainingMs) : t('vote.banner.open')}
          </span>
        </div>
        <span
          style={{
            fontSize: 12, fontWeight: 600,
            background: 'var(--bg-panel-2)', color: 'var(--text-mid)',
            padding: '4px 10px', borderRadius: 999,
            whiteSpace: 'nowrap',
          }}
        >
          {zTimer.voteLimit != null
            ? t('vote.banner.votesUsed', { used: votesUsed, limit: zTimer.voteLimit })
            : t('vote.banner.unlimited')}
        </span>
        {isAdmin && (
          <>
            <div aria-hidden style={{ width: 1, height: 22, background: 'var(--border-soft)' }} />
            {[1, 2, 5].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => adminExtendTimer(zone.id, m)}
                title={t('topbar.extend', { m }) || `+${m}m`}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  padding: '5px 10px',
                  fontSize: 12, fontWeight: 700,
                  color: 'var(--text-mid)',
                  cursor: 'pointer',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >+{m}m
              </button>
            ))}
            <div aria-hidden style={{ width: 1, height: 22, background: 'var(--border-soft)' }} />
            <button
              type="button"
              onClick={() => adminStopTimer(zone.id)}
              title={t('topbar.stopVote')}
              style={{
                background: '#dc2626', color: '#fff',
                border: 'none', borderRadius: 8,
                padding: '6px 12px', fontSize: 13, fontWeight: 700,
                cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              <Square size={14} /> {t('topbar.stopVote')}
            </button>
          </>
        )}
      </div>
    );
  };

  const renderTimerDocks = () => {
    const activeZones = board.items.filter((i) => i.type === 'zone' && i.voteTimer);
    if (!activeZones.length) return null;
    return (
      <div
        style={{
          position: 'fixed', left: '50%', bottom: 16, transform: 'translateX(-50%)',
          display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', zIndex: 41,
        }}
      >
        {activeZones.map((z) => renderTimerDockFor(z))}
      </div>
    );
  };

  const renderBottomBar = () => (
    <>
      {/* Templates (bottom-left) */}
      <div style={{ position: 'fixed', bottom: 16, left: 16, zIndex: 40 }}>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setTemplatesOpen((v) => !v)}
            style={floatBtn}
          >
            <LayoutTemplate size={16} /> Templates <ChevronDown size={14} />
          </button>
          {templatesOpen && (
            <>
              {/* click-outside backdrop */}
              <div
                onClick={() => setTemplatesOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 59 }}
              />
              <div
                data-board-shortcuts="off"
                style={{
                  position: 'absolute', bottom: '120%', left: 0,
                  background: 'var(--bg-panel)', borderRadius: 12, padding: 8,
                  boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
                  minWidth: 300, maxHeight: '70vh', overflow: 'auto', zIndex: 60,
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 8px', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>built-in</div>
                {Object.entries(getTemplates()).map(([k, v]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => applyTemplate(k)}
                    style={tplRow}
                    onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-panel-2)'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {v.name}
                  </button>
                ))}
                {customTemplates.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '10px 8px 6px', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>custom</div>
                    {customTemplates.map((ct) => (
                      <div
                        key={ct.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                        onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-panel-2)'; }}
                        onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <button
                          type="button"
                          onClick={() => applyTemplate(ct.id)}
                          style={{ ...tplRow, flex: 1 }}
                        >
                          {ct.name}
                          <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 6 }}>· {ct.zones.length} zones</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteCustomTemplate(ct.id)}
                          title={t('common.delete')}
                          style={{
                            background: 'transparent', border: 'none', color: 'var(--text-faint)',
                            padding: 6, marginRight: 4, borderRadius: 6, cursor: 'pointer',
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </>
                )}
                <div style={{ height: 1, background: 'var(--border)', margin: '8px 4px' }} />
                <button
                  type="button"
                  onClick={() => { setSaveTemplateOpen(true); setTemplatesOpen(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    width: '100%', background: 'transparent', border: 'none',
                    padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                    fontSize: 13, color: 'var(--accent)', fontWeight: 600,
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.background = 'var(--accent-bg)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {t('tmpl.save')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Creator toolbar (bottom-left, next to templates) */}
      <div style={{
        position: 'fixed', bottom: 16, left: 170, zIndex: 40,
        display: 'flex', gap: 8,
      }}
      >
        <button
          type="button"
          onClick={() => {
            setCreationMode((m) => (m === 'select' ? null : 'select'));
            setSelectedIds(new Set());
          }}
          style={{
            ...floatBtn,
            background: creationMode === 'select' ? 'var(--accent)' : 'var(--bg-panel)',
            color: creationMode === 'select' ? '#fff' : 'var(--text)',
          }}
          title={creationMode === 'select' ? t('tool.select.active') : t('tool.select.title')}
        >
          <MousePointer2 size={16} />
          {creationMode === 'select' ? t('tool.select.placeholder') : t('tool.select')}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!requireEdit() || !canvasRef.current) return;
            const rect = canvasRef.current.getBoundingClientRect();
            const w = screenToWorld(rect.width / 2, rect.height / 2);
            addText(w.x, w.y);
          }}
          style={floatBtn}
          title={t('tool.text.title')}
        >
          <Type size={16} /> {t('tool.text')}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!requireEdit()) return;
            setCreationMode((m) => (m === 'zone' ? null : 'zone'));
            setSelectedIds(new Set());
          }}
          style={{
            ...floatBtn,
            background: creationMode === 'zone' ? 'var(--accent)' : 'var(--bg-panel)',
            color: creationMode === 'zone' ? '#fff' : 'var(--text)',
          }}
          title={creationMode === 'zone' ? t('tool.zone.active') : t('tool.zone.title')}
        >
          {creationMode === 'zone' ? <MousePointer2 size={16} /> : <LayoutTemplate size={16} />}
          {creationMode === 'zone' ? t('tool.zone.placeholder') : t('tool.zone')}
        </button>
        <button
          type="button"
          onClick={pickImageFile}
          style={floatBtn}
          title={t('tool.image.title')}
        >
          <ImageIcon size={16} /> {t('tool.image')}
        </button>
      </div>

      {/* Zoom (bottom-right) */}
      <div
        style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 40,
          background: 'var(--bg-panel)', borderRadius: 10,
          boxShadow: '0 6px 16px rgba(0,0,0,0.1)',
          display: 'flex', alignItems: 'center', overflow: 'hidden',
        }}
      >
        <button type="button" onClick={() => zoomBy(1 / 1.2)} style={zoomBtn} title="Zoom out">
          <ZoomOut size={16} />
        </button>
        <button type="button" onClick={resetZoom} style={{
          ...zoomBtn, fontSize: 13, minWidth: 70, justifyContent: 'center',
        }}
        title={t('zoom.reset')}
        >{Math.round(viewport.zoom * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.2)} style={zoomBtn} title="Zoom in">
          <ZoomIn size={16} />
        </button>
        <button type="button" onClick={fitToContent} style={zoomBtn} title="Fit to content">
          <Maximize2 size={16} />
        </button>
      </div>
    </>
  );

  /* ============================================================
     Render
     ============================================================ */

  if (!loaded) {
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg)', color: 'var(--text-muted)',
        fontFamily: '"Plus Jakarta Sans", "Sarabun", sans-serif',
      }}
      >{t('loading') || 'Loading…'}
      </div>
    );
  }

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', fontFamily: '"Plus Jakarta Sans", "Sarabun", sans-serif' }}
    >
      {/* Google fonts */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Sarabun:wght@400;600;700&family=Caveat:wght@400;700&display=swap"
        rel="stylesheet"
      />

      <style>{`
        @keyframes rb-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220,38,38,0.5); }
          50% { transform: scale(1.04); box-shadow: 0 0 0 12px rgba(220,38,38,0); }
        }
        @keyframes rb-appear {
          0%   { opacity: 0; transform: scale(0.78); }
          60%  { opacity: 1; transform: scale(1.04); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes rb-appear-rot {
          0%   { opacity: 0; transform: scale(0.78) rotate(var(--rb-rot, 0deg)); }
          60%  { opacity: 1; transform: scale(1.04) rotate(var(--rb-rot, 0deg)); }
          100% { opacity: 1; transform: scale(1) rotate(var(--rb-rot, 0deg)); }
        }
        @keyframes rb-bump {
          0%   { transform: scale(1); }
          40%  { transform: scale(1.28); }
          100% { transform: scale(1); }
        }
        @keyframes rb-vote-float {
          0%   { opacity: 0; transform: translate(-50%, 0) scale(0.6); }
          20%  { opacity: 1; transform: translate(-50%, -10px) scale(1.1); }
          100% { opacity: 0; transform: translate(-50%, -55px) scale(1.1); }
        }
        @keyframes rb-toast-in {
          0%   { opacity: 0; transform: translate(-50%, 14px) scale(0.96); }
          100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
        }
        @keyframes rb-banner-in {
          0%   { opacity: 0; transform: translateY(-14px) scale(0.9); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes rb-pop {
          0%   { opacity: 0; transform: scale(0.9); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes rb-glow {
          0%, 100% { box-shadow: 0 0 0 3px rgba(251,191,36,0.7), 0 0 18px rgba(251,191,36,0.6), 0 6px 14px rgba(0,0,0,0.12); }
          50%      { box-shadow: 0 0 0 3px rgba(251,191,36,1.0), 0 0 28px rgba(251,191,36,1.0), 0 6px 14px rgba(0,0,0,0.12); }
        }
        .rb-no-select * { user-select: none; }
      `}</style>

      {/* Grid background (screen-space, behind everything). backgroundSize
          and backgroundPosition are applied imperatively (see
          applyViewportToDom) so pan/zoom don't go through React. */}
      <div
        ref={gridRef}
        style={{
          position: 'absolute', inset: 0, zIndex: 0,
          backgroundColor: 'var(--bg)',
          backgroundImage: 'radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)',
        }}
      />

      {/* Canvas surface */}
      <div
        ref={canvasRef}
        onMouseDownCapture={onCanvasMouseDownCapture}
        onMouseDown={onCanvasMouseDown}
        onDoubleClick={onCanvasDoubleClick}
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
        className="rb-no-select"
        style={{
          position: 'absolute', inset: 0, zIndex: 1,
          cursor: interactionRef.current?.kind === 'pan' ? 'grabbing'
            : spaceHeldRef.current ? 'grab'
            : creationMode === 'zone' ? 'crosshair'
            : creationMode === 'select' ? 'crosshair'
            : 'default',
        }}
      >
        {/* Transformed world — transform applied imperatively (see
            applyViewportToDom) so pan/zoom skip React reconciliation. */}
        <div
          ref={worldRef}
          style={{
            position: 'absolute', top: 0, left: 0,
            transformOrigin: '0 0',
          }}
        >
          {renderedItems}

          {/* Zone-creation preview */}
          {zonePreview && (
            <div
              style={{
                position: 'absolute',
                left: zonePreview.x,
                top: zonePreview.y,
                width: zonePreview.w,
                height: zonePreview.h,
                background: 'rgba(14,165,233,0.10)',
                border: '2px dashed #0ea5e9',
                borderRadius: 12,
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        {/* Empty hint */}
        {board.items.length === 0 && (
          <div
            style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'var(--text-faint)', textAlign: 'center', pointerEvents: 'none',
              fontSize: 16,
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 8 }}>✨</div>
            {t('empty.hint')}
          </div>
        )}
      </div>

      {/* Floating UI */}
      {renderTopBar()}
      {renderBottomBar()}
      {renderTimerDocks()}
      {renderActionToolbar()}
      {renderResizeHandles()}

      {/* Marquee selection box */}
      {marquee && (
        <div
          style={{
            position: 'fixed',
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
            background: 'rgba(37,99,235,0.10)',
            border: '1.5px solid #2563eb',
            borderRadius: 2,
            pointerEvents: 'none',
            zIndex: 35,
          }}
        />
      )}

      {/* Save template modal */}
      {saveTemplateOpen && (
        <SaveTemplateModal
          onClose={() => setSaveTemplateOpen(false)}
          onSave={saveCurrentAsTemplate}
          zoneCount={board.items.filter((i) => i.type === 'zone').length}
        />
      )}

      {/* Name modal */}
      {nameModalOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--bg-panel)', borderRadius: 14, padding: 24,
              minWidth: 320, boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>
              {t('name.head')}
            </div>
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
              placeholder={t('name.placeholder')}
              style={{
                width: '100%', padding: '10px 12px', fontSize: 15,
                border: '1px solid var(--border)', borderRadius: 8, outline: 'none',
                background: 'var(--bg-panel)', color: 'var(--text)',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={saveName}
                style={{
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: 'pointer', fontSize: 14,
                }}
              >{t('name.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset votes confirm */}
      {confirmResetVotes && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--bg-elev)', borderRadius: 14, padding: 24,
              minWidth: 320, boxShadow: 'var(--shadow-modal)',
              animation: 'rb-pop 0.2s ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <RotateCcw size={22} color="var(--accent)" />
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{t('reset.confirm.head')}</div>
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 18 }}>
              {t('reset.confirm.body')}
              <br />
              {t('reset.confirm.body2')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmResetVotes(false)}
                style={{
                  background: 'var(--bg-panel-2)', color: 'var(--text-mid)', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: 'pointer', fontSize: 14,
                }}
              >{t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => requireAdminPin(adminResetVotes)}
                style={{
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: 'pointer', fontSize: 14,
                }}
              >{t('reset.confirm.ok')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import confirm */}
      {pendingImport && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'var(--bg-modal-veil)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--bg-elev)', borderRadius: 14, padding: 24,
              minWidth: 360, boxShadow: 'var(--shadow-modal)',
              animation: 'rb-pop 0.2s ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Upload size={22} color="var(--accent)" />
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{t('import.confirm.head')}</div>
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 18 }}>
              {importBusy ? t('import.processing') : t('import.confirm.body', {
                n: pendingImport.parsed?.board?.items?.length ?? 0,
                file: pendingImport.name,
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                autoFocus
                onClick={() => setPendingImport(null)}
                disabled={importBusy}
                style={{
                  background: 'var(--bg-panel-2)', color: 'var(--text-mid)', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: importBusy ? 'not-allowed' : 'pointer', fontSize: 14,
                  opacity: importBusy ? 0.6 : 1,
                }}
              >{t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={confirmImport}
                disabled={importBusy}
                style={{
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: importBusy ? 'not-allowed' : 'pointer', fontSize: 14,
                  opacity: importBusy ? 0.6 : 1,
                }}
              >{importBusy ? t('import.processing') : t('import.confirm.ok')}
              </button>
            </div>
          </div>
        </div>
      )}

      {helpOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setHelpOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'var(--bg-modal-veil)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-elev)', borderRadius: 14, padding: 24,
              width: '100%', maxWidth: 680, maxHeight: '82vh', overflowY: 'auto',
              boxShadow: 'var(--shadow-modal)',
              animation: 'rb-pop 0.2s ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <HelpCircle size={22} color="var(--accent)" />
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{t('help.title')}</div>
              </div>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                aria-label={t('common.close')}
                style={{
                  background: 'transparent', border: 'none', color: 'var(--text-muted)',
                  cursor: 'pointer', padding: 4, display: 'inline-flex',
                }}
              ><X size={18} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {HELP_SECTIONS.map((s) => (
                <div key={s.key}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{
                      width: 10, height: 10, borderRadius: 3, flexShrink: 0,
                      background: COLORS[s.color].border,
                    }}
                    />
                    <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>{t(`help.${s.key}.title`)}</div>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {t(`help.${s.key}.body`).split('\n').map((line) => (
                      <li key={line} style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>{line}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Clear board confirm */}
      {/* Admin PIN gate — set on first use, verify after. Cached for the
          tab session via pinSessionOkRef so subsequent destructive actions
          don't pester the admin. */}
      {pinPromptCfg && (
        <AdminPinModal
          cfg={pinPromptCfg}
          onCancel={pinPromptCfg.onCancel}
          onSubmit={pinPromptCfg.onSuccess}
        />
      )}

      {confirmClear && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'var(--bg-modal-veil)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--bg-elev)', borderRadius: 14, padding: 24,
              minWidth: 320, boxShadow: 'var(--shadow-modal)',
              animation: 'rb-pop 0.2s ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <AlertCircle size={22} color="var(--danger)" />
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{t('clear.confirm.head')}</div>
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 18 }}>
              {t('clear.confirm.body')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmClear(false)}
                style={{
                  background: 'var(--bg-panel-2)', color: 'var(--text-mid)', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: 'pointer', fontSize: 14,
                }}
              >{t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => requireAdminPin(adminClearBoard)}
                style={{
                  background: 'var(--danger)', color: '#fff', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: 'pointer', fontSize: 14,
                }}
              >{t('clear.confirm.ok')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          key={toast.t || toast.msg}
          style={{
            position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
            background: toast.type === 'warn' ? 'var(--toast-warn-bg)' : 'var(--toast-bg)',
            color: '#fff', padding: '10px 16px', borderRadius: 10,
            fontSize: 14, fontWeight: 500, zIndex: 200,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            animation: 'rb-toast-in 0.28s ease-out',
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <span>{toast.msg}</span>
          {toast.sticky && (
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label={t('common.close')}
              style={{
                background: 'transparent', border: 'none', color: '#fff',
                opacity: 0.8, cursor: 'pointer', padding: 2, display: 'inline-flex',
              }}
            ><X size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Small subcomponents & style helpers
   ============================================================ */

const iconBtn = (enabled) => ({
  background: 'transparent',
  border: 'none',
  padding: 4,
  borderRadius: 6,
  cursor: enabled ? 'pointer' : 'not-allowed',
  color: enabled ? 'var(--text-mid)' : 'var(--text-faint)',
  display: 'inline-flex',
  alignItems: 'center',
});

const floatBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'var(--bg-panel)',
  border: 'none',
  borderRadius: 10,
  padding: '8px 14px',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text)',
  boxShadow: '0 6px 16px rgba(0,0,0,0.1)',
  cursor: 'pointer',
};

const tplRow = {
  display: 'block', width: '100%', textAlign: 'left',
  background: 'transparent', border: 'none',
  padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
  fontSize: 13, color: 'var(--text)',
};

const zoomBtn = {
  background: 'transparent',
  border: 'none',
  padding: '8px 10px',
  cursor: 'pointer',
  color: 'var(--text-mid)',
  display: 'inline-flex',
  alignItems: 'center',
};

function AdminPinModal({ cfg, onCancel, onSubmit }) {
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const isSetting = cfg.isSetting;
  const valid = /^[0-9]{4,8}$/.test(pin);
  const matches = !isSetting || pin === pin2;
  const submit = async () => {
    if (!valid || !matches || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(pin);
    } catch (e) {
      setErr(e?.message || t('pin.genericError') || 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 110,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'var(--bg-elev)', borderRadius: 14, padding: 24,
          minWidth: 320, maxWidth: 380, boxShadow: 'var(--shadow-modal)',
          animation: 'rb-pop 0.18s ease-out',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <Lock size={20} color="var(--accent)" />
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>
            {isSetting ? (t('pin.setHead') || 'Set admin PIN') : (t('pin.verifyHead') || 'Enter admin PIN')}
          </div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
          {isSetting
            ? (t('pin.setBody') || '4–8 digits. Required for Clear / Reset / Transfer.')
            : (t('pin.verifyBody') || 'Confirm this destructive action.')}
        </div>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
          placeholder="••••"
          style={{
            width: '100%', padding: '10px 12px', fontSize: 18,
            letterSpacing: 6, textAlign: 'center',
            border: '1px solid var(--border)', borderRadius: 8, outline: 'none',
            background: 'var(--bg-panel)', color: 'var(--text)',
            boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace',
          }}
        />
        {isSetting && (
          <input
            type="password"
            inputMode="numeric"
            value={pin2}
            onChange={(e) => setPin2(e.target.value.replace(/\D/g, '').slice(0, 8))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
            placeholder={t('pin.confirm') || 'confirm'}
            style={{
              marginTop: 8,
              width: '100%', padding: '10px 12px', fontSize: 18,
              letterSpacing: 6, textAlign: 'center',
              border: '1px solid var(--border)', borderRadius: 8, outline: 'none',
              background: 'var(--bg-panel)', color: 'var(--text)',
              boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace',
            }}
          />
        )}
        {cfg.error === 'wrong' && (
          <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>
            {t('pin.wrong') || 'Wrong PIN'}
          </div>
        )}
        {err && (
          <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>
            {err}
          </div>
        )}
        {isSetting && pin && pin2 && !matches && (
          <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>
            {t('pin.mismatch') || "PINs don't match"}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              background: 'var(--bg-panel-2)', color: 'var(--text-mid)', border: 'none',
              padding: '8px 16px', borderRadius: 8, fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer', fontSize: 14,
            }}
          >{t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!valid || !matches || busy}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none',
              padding: '8px 16px', borderRadius: 8, fontWeight: 600,
              cursor: (!valid || !matches || busy) ? 'not-allowed' : 'pointer',
              opacity: (!valid || !matches || busy) ? 0.5 : 1,
              fontSize: 14,
            }}
          >{isSetting ? (t('pin.set') || 'Set PIN') : (t('pin.unlock') || 'Unlock')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TopBtn({
  title, onClick, active, enabled, icon, label, danger, disabledHint,
}) {
  const baseColor = active
    ? 'var(--warn-text)'
    : danger
      ? '#dc2626'
      : 'var(--text-mid)';
  return (
    <button
      type="button"
      onClick={onClick}
      title={enabled ? title : (disabledHint || `${title} (admin only)`)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: active ? 'var(--warn-bg)' : 'transparent',
        color: enabled ? baseColor : 'var(--text-faint)',
        border: '1px solid',
        borderColor: active ? '#fbbf24' : 'var(--border-strong)',
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 13,
        fontWeight: 600,
        cursor: enabled ? 'pointer' : 'not-allowed',
      }}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}

function MoreMenuItem({ icon, label, onClick, disabled, danger, checked }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={checked == null ? undefined : checked}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', textAlign: 'left',
        background: 'transparent', border: 'none',
        padding: '8px 10px', borderRadius: 8,
        fontSize: 13, fontWeight: 500,
        color: disabled ? 'var(--text-faint)' : danger ? '#dc2626' : 'var(--text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseOver={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--bg-panel-2)'; }}
      onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ display: 'inline-flex', width: 18, justifyContent: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {checked && <Check size={15} />}
    </button>
  );
}

function MoreMenuDivider() {
  return <div aria-hidden style={{ height: 1, background: 'var(--border-soft)', margin: '4px 6px' }} />;
}

function TopBarDivider() {
  return (
    <div
      aria-hidden
      style={{
        width: 1, height: 22,
        background: 'var(--border-strong)',
        margin: '0 4px',
        opacity: 0.6,
      }}
    />
  );
}

function Avatar({ id, name, crown, ring, small }) {
  const size = small ? 22 : 28;
  const hue = hueFromId(id || 'x');
  return (
    <div
      style={{
        position: 'relative',
        width: size, height: size, borderRadius: '50%',
        background: `hsl(${hue}, 65%, 55%)`,
        color: '#fff', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: small ? 11 : 12,
        boxShadow: ring ? '0 0 0 2px #fff, 0 0 0 3px rgba(0,0,0,0.08)' : 'none',
      }}
    >
      {initialOf(name)}
      {crown && (
        <span
          style={{
            position: 'absolute', top: -6, right: -4,
            background: '#facc15', borderRadius: '50%',
            width: 14, height: 14, display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center',
            color: '#7c2d12',
            border: '1.5px solid #fff',
          }}
        >
          <Crown size={9} />
        </span>
      )}
    </div>
  );
}

function TimerSetup({ onClose, onStart, nestedZoneCount }) {
  const [minutes, setMinutes] = useState(3);
  const [noTimeLimit, setNoTimeLimit] = useState(false);
  const [votes, setVotes] = useState(3);
  const [unlimitedVotes, setUnlimitedVotes] = useState(false);
  const [hideResults, setHideResults] = useState(true);
  const [showNonVoters, setShowNonVoters] = useState(false);
  const submit = () => onStart(noTimeLimit ? 0 : minutes, unlimitedVotes ? null : votes, hideResults, showNonVoters);
  return (
    <div
      data-board-shortcuts="off"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute', top: '110%', right: 0, marginTop: 6,
        background: 'var(--bg-elev)', borderRadius: 14, padding: 16,
        boxShadow: 'var(--shadow-pop)',
        minWidth: 320, zIndex: 60,
        animation: 'rb-pop 0.18s ease-out',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <ThumbsUp size={16} color="var(--accent)" />
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{t('vote.setup.head')}</div>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
          <X size={16} />
        </button>
      </div>

      {nestedZoneCount > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          {t('vote.session.coversNested', { n: nestedZoneCount })}
        </div>
      )}

      {/* Duration */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>{t('vote.setup.duration')}</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={noTimeLimit} onChange={(e) => setNoTimeLimit(e.target.checked)} />
          {t('vote.setup.unlimitedTime')}
        </label>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, opacity: noTimeLimit ? 0.4 : 1, pointerEvents: noTimeLimit ? 'none' : 'auto' }}>
        {TIMER_PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMinutes(m)}
            style={{
              flex: 1, padding: '6px 0', borderRadius: 8,
              border: '1px solid',
              borderColor: minutes === m ? 'var(--accent)' : 'var(--border)',
              background: minutes === m ? 'var(--accent-bg)' : 'var(--bg-panel)',
              color: minutes === m ? 'var(--accent-text)' : 'var(--text-mid)',
              cursor: 'pointer', fontWeight: 600, fontSize: 13,
            }}
          >{m}m
          </button>
        ))}
        <input
          type="number"
          min={1}
          max={120}
          value={minutes}
          onChange={(e) => setMinutes(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
          style={{
            width: 64, padding: '6px 8px',
            border: '1px solid var(--border)', borderRadius: 8,
            background: 'var(--bg-panel)', color: 'var(--text)',
            fontSize: 13, textAlign: 'center',
          }}
        />
      </div>

      {/* Vote limit */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>{t('vote.setup.voteLimit')}</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={unlimitedVotes} onChange={(e) => setUnlimitedVotes(e.target.checked)} />
          {t('vote.setup.unlimitedVotes')}
        </label>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, opacity: unlimitedVotes ? 0.4 : 1, pointerEvents: unlimitedVotes ? 'none' : 'auto' }}>
        {[1, 3, 5, 10].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVotes(v)}
            style={{
              flex: 1, padding: '6px 0', borderRadius: 8,
              border: '1px solid',
              borderColor: votes === v ? 'var(--accent)' : 'var(--border)',
              background: votes === v ? 'var(--accent-bg)' : 'var(--bg-panel)',
              color: votes === v ? 'var(--accent-text)' : 'var(--text-mid)',
              cursor: 'pointer', fontWeight: 600, fontSize: 13,
            }}
          >{v}
          </button>
        ))}
        <input
          type="number"
          min={1}
          max={50}
          value={votes}
          onChange={(e) => setVotes(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          style={{
            width: 64, padding: '6px 8px',
            border: '1px solid var(--border)', borderRadius: 8,
            background: 'var(--bg-panel)', color: 'var(--text)',
            fontSize: 13, textAlign: 'center',
          }}
        />
      </div>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 14, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
        <input type="checkbox" checked={hideResults} onChange={(e) => setHideResults(e.target.checked)} />
        {t('vote.setup.hideResults')}
      </label>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 14, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
        <input type="checkbox" checked={showNonVoters} onChange={(e) => setShowNonVoters(e.target.checked)} />
        {t('vote.setup.showNonVoters')}
      </label>

      <button
        type="button"
        onClick={submit}
        style={{
          width: '100%', padding: '10px 0',
          background: 'var(--accent)', color: '#fff', border: 'none',
          borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(14,165,233,0.35)',
        }}
      >
        {t('vote.setup.start')}
      </button>
    </div>
  );
}

function SaveTemplateModal({ onClose, onSave, zoneCount }) {
  const [name, setName] = useState('');
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'var(--bg-modal-veil)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'var(--bg-elev)', borderRadius: 14, padding: 24,
          minWidth: 340, boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6, color: 'var(--text)' }}>
          {t('tmpl.saveDialog.head')}
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name); if (e.key === 'Escape') onClose(); }}
          placeholder={t('tmpl.saveDialog.placeholder')}
          style={{
            width: '100%', padding: '10px 12px', fontSize: 15,
            border: '1px solid var(--border)', borderRadius: 8, outline: 'none',
            background: 'var(--bg-panel)', color: 'var(--text)',
            boxSizing: 'border-box', marginTop: 8,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'var(--bg-panel-2)', color: 'var(--text-mid)', border: 'none',
              padding: '8px 16px', borderRadius: 8, fontWeight: 600,
              cursor: 'pointer', fontSize: 14,
            }}
          >{t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!name.trim() || zoneCount === 0}
            onClick={() => onSave(name)}
            style={{
              background: name.trim() && zoneCount > 0 ? 'var(--accent)' : 'var(--text-faint)',
              color: '#fff', border: 'none',
              padding: '8px 16px', borderRadius: 8, fontWeight: 600,
              cursor: name.trim() && zoneCount > 0 ? 'pointer' : 'not-allowed',
              fontSize: 14,
            }}
          >{t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
