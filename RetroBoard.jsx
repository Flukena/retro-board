// RetroBoard.jsx — Miro-style retrospective board (single-file artifact)
// Yjs-backed realtime board with character-level collaborative text editing.

import React, {
  useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, startTransition,
} from 'react';
import {
  Trash2, Lock, Unlock, Eye, EyeOff, ZoomIn, ZoomOut, Maximize2,
  ThumbsUp, Crown, Clock, Square, LayoutTemplate,
  ChevronDown, X, Sparkles, AlertCircle, Type, Copy,
  Image as ImageIcon, MousePointer2, RotateCcw,
  Languages, Sun, Moon, Monitor, Download, Upload, Undo2, Redo2,
  MoreHorizontal, Check, BringToFront, SendToBack, HelpCircle,
  MessageSquare, Map as MapIcon, LocateFixed,
} from 'lucide-react';
import { COMMENT_MAX_LEN } from './src/comment-schema.js';
import {
  IMPORT_MAX_BUNDLE_BYTES,
  IMPORT_MAX_ARCHIVE_FILE_BYTES,
  IMPORT_MAX_CSV_FILE_BYTES,
  IMPORT_MAX_FILE_BYTES,
  importBundleByteLength,
  normalizeCustomTemplates,
  normalizeImportManifest,
} from './src/import-schema.js';
import { parseBoardCsv } from './src/csv-import.js';
import { createCsvExportArtifact } from './src/board-backup.js';
import { restoreBackupImages } from './src/backup-images.js';
import { geometryErrorForItem, geometryErrorForPatch } from './src/board-geometry.js';
import {
  BOARD_TEXT_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  IMAGE_MAX_BYTES,
  IMAGE_OUTPUT_MAX_DIMENSION,
  TEMPLATE_NAME_MAX_LENGTH,
  ZONE_TITLE_MAX_LENGTH,
  imageInfoIsWithinLimits,
  inspectRasterImageBlob,
  isSafeImageMime,
  normalizeRuntimeImageSource,
  redactBoardExportForViewer,
  stickyTextForDom,
} from './src/security-boundaries.js';
import { t, useLang } from './src/i18n.js';
import { getActiveRoomSession, roomFetch } from './src/room-session.js';
import { useTheme, nextThemePref } from './src/theme.js';
import { PALETTE, FONT_COLORS, STICKY_AUTO_TEXT, STICKY_AUTO_TEXT_FAINT } from './src/palette.js';
import {
  TOPBAR_INSET_PX, TOPBAR_H_PX, TOPBAR_BOTTOM_PX, FOLLOW_BANNER_GAP_PX,
  SELECTION_TOOLBAR_GAP_PX, GRID_PITCH_PX, toolbarAnchorY, Z,
} from './src/chrome-layout.js';
import { useUserIdentity } from './src/useUserIdentity.js';
import { useAdminRole } from './src/useAdminRole.js';
import { clientPointToWorld } from './src/board-coordinates.js';
import { buildTopVotedRanks } from './src/voting-results.js';
import {
  allowCanvasFileDrop,
  dragClientPoint,
  droppedImageBlobs,
  resolveDropClientPoint,
} from './src/image-drop.js';
import { unlockEntriesForSelection } from './src/selection-actions.js';
import {
  buildMinimapModel,
  centerViewportOnWorld,
  minimapPointToWorld,
  minimapViewportRect,
} from './src/minimap.js';
import {
  cursorScreenPosition,
  PLAYER_CURSOR_STALE_MS,
  playerViewFromViewport,
  visiblePlayerCursors,
} from './src/player-cursors.js';
import { summarizeRemoteEditors, summarizeRemoteSelectors } from './src/editing-presence.js';
import {
  describeTextReplacement,
  mapSelectionIndexThroughReplacement,
} from './src/collaborative-text.js';
import { copyTextToClipboard } from './src/clipboard.js';
import { MinimapCanvas } from './src/MinimapCanvas.jsx';
import { wheelZoomFactor, viewportNeedsCullRefresh } from './src/viewport-zoom.js';
import { centerOf, insideZone, resolveOwnerZone, effectiveOwnerZone } from './src/board-ownership.js';
import {
  normalizeDisplayName,
  normalizeStoredUserId,
  normalizeViewport,
} from './src/local-preferences.js';
import { voteTimerIsOpen, voteTimerPhaseSignature } from './src/vote-timing.js';
import { planVoteFinalization } from './src/vote-finalization.js';

const loadBoardArchive = () => import('./src/board-archive.js');

/* ============================================================
   Constants
   ============================================================ */


const STICKY_W = 200;
const STICKY_H = 180;
const STICKY_MIN_W = 120;
const STICKY_MIN_H = 100;
// Let notes grow while typing, but keep a pasted essay from turning into a
// many-thousand-pixel card. At the cap the editor becomes internally scrollable.
const STICKY_AUTO_GROW_MAX_H = 900;
const ZONE_MIN_W = 240;
const ZONE_MIN_H = 200;
const IMAGE_MIN_W = 60;
const IMAGE_MIN_H = 40;
const TEXT_W = 400;
const TEXT_H = 80;
const TEXT_MIN_W = 60;
const TEXT_MIN_H = 30;
// A full board import writes every item in one Yjs transaction, which the
// WebsocketProvider then sends as a single WS frame. Must stay safely under
// the server's per-frame cap (RL_MAX_BYTES in yjs-server.mjs, 2MB) — legacy
// exports with embedded base64 images get converted back to short URLs
// before this check (see sanitizeImportedImages), but this is the
// belt-and-suspenders net for anything that still doesn't fit.
const ZONE_TITLE_H = 40;
const DRAG_THRESHOLD = 4;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3.0;
const MINIMAP_W = 220;
const MINIMAP_H = 132;
const MINIMAP_IDLE_MS = 1100;
const CURSOR_BROADCAST_MS = 24;
const FOLLOW_VIEWPORT_COMMIT_MS = 96;
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
const COMMENT_PREVIEW_TEXT_LIMIT = 120;
const COMMENT_CAROUSEL_MS = 3600;
const EMPTY_COMMENT_PREVIEWS = [];
const EMPTY_COMMENTS = [];

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

// Help modal sections, in display order. `color` indexes PALETTE so each
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
  getPresenceSnapshot() {
    try { return window.storage?.getPresenceSnapshot?.() || {}; } catch { return {}; }
  },
  onPresenceChange(handler) {
    try { return window.storage?.onPresenceChange?.(handler) || (() => {}); } catch { return () => {}; }
  },
  offPresenceChange(handler) {
    try { window.storage?.offPresenceChange?.(handler); } catch { /* noop fallback */ }
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
  getRemoteEditingItems() {
    try { return window.storage?.getRemoteEditingItems?.() || new Map(); } catch { return new Map(); }
  },
  onEditingChange(handler) {
    try { return window.storage?.onEditingChange?.(handler) || (() => {}); } catch { return () => {}; }
  },
  offEditingChange(handler) {
    try { window.storage?.offEditingChange?.(handler); } catch { /* noop fallback */ }
  },
  setLocalSelectedItems(ids) {
    try { window.storage?.setLocalSelectedItems?.(ids); } catch { /* noop fallback */ }
  },
  getRemoteSelectedItems() {
    try { return window.storage?.getRemoteSelectedItems?.() || new Map(); } catch { return new Map(); }
  },
  onSelectionChange(handler) {
    try { return window.storage?.onSelectionChange?.(handler) || (() => {}); } catch { return () => {}; }
  },
  offSelectionChange(handler) {
    try { window.storage?.offSelectionChange?.(handler); } catch { /* noop fallback */ }
  },
  // --- Granular board writes ---
  // Pass through to the Yjs bridge when present; otherwise mutate the in-memory
  // board so dev/preview (no relay) stays consistent. Each maps to one Yjs
  // transaction in the bridge; `opts.silent` keeps derived writes off undo.
  addItem(item, opts) {
    if (window.storage?.addItem) {
      try { return window.storage.addItem(item, opts) === true; } catch { return false; }
    }
    const b = memBoard(); memSetBoard({ ...b, items: [...b.items, item] });
    return true;
  },
  addItems(items, opts) {
    if (window.storage?.addItems) {
      try { return window.storage.addItems(items, opts) === true; } catch { return false; }
    }
    const b = memBoard();
    const ids = new Set(b.items.map((it) => it.id));
    const additions = [];
    items.forEach((it) => {
      if (!it || !it.id || ids.has(it.id)) return;
      ids.add(it.id);
      additions.push(it);
    });
    if (additions.length !== items.length) return false;
    memSetBoard({ ...b, items: [...b.items, ...additions] });
    return true;
  },
  updateItem(id, patch, opts) {
    if (window.storage?.updateItem) {
      try { return window.storage.updateItem(id, patch, opts) === true; } catch { return false; }
    }
    const b = memBoard();
    if (!b.items.some((it) => it.id === id)) return false;
    memSetBoard({ ...b, items: b.items.map((it) => (it.id === id ? memMerge(it, patch) : it)) });
    return true;
  },
  updateItems(entries, opts) {
    if (window.storage?.updateItems) {
      try { return window.storage.updateItems(entries, opts) === true; } catch { return false; }
    }
    const byId = new Map(entries.map((e) => [e.id, e.patch]));
    const b = memBoard();
    if (entries.some((entry) => !b.items.some((it) => it.id === entry.id))) return false;
    memSetBoard({ ...b, items: b.items.map((it) => (byId.has(it.id) ? memMerge(it, byId.get(it.id)) : it)) });
    return true;
  },
  removeItem(id, opts) {
    if (window.storage?.removeItem) { window.storage.removeItem(id, opts); return; }
    const b = memBoard(); memSetBoard({ ...b, items: b.items.filter((it) => it.id !== id) });
  },
  setMeta(patch, opts) {
    if (window.storage?.setMeta) {
      try { return window.storage.setMeta(patch, opts) === true; } catch { return false; }
    }
    memSetBoard(memMerge(memBoard(), patch));
    return true;
  },
  replaceBoard(board, opts) {
    if (window.storage?.replaceBoard) {
      try { return window.storage.replaceBoard(board, opts) === true; } catch { return false; }
    }
    memSetBoard(board);
    return true;
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

// Nearest zone — the item's own owner, or the nearest ancestor via the
// ownership chain — that currently has an active voteTimer. Mutual exclusion
// at start time guarantees at most one zone in a chain is active at once.
const activeVoteZone = (item, allItems, atTime) => {
  let zone = effectiveOwnerZone(item, allItems);
  const visited = new Set();
  while (zone && !visited.has(zone.id)) {
    visited.add(zone.id);
    const timer = zone.voteTimer;
    if (voteTimerIsOpen(timer, atTime)) return zone;
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

// One privacy predicate for every non-owner view (card chrome, modal, copy,
// and exports). Keeping it beside effectiveRevealed prevents those surfaces
// from drifting when nested-zone inheritance changes.
const isStickyHiddenForUser = (item, allItems, boardAllRevealed, userId) => (
  item?.type === 'sticky'
  && item.private
  && item.authorId !== userId
  && !effectiveRevealed(item, allItems, boardAllRevealed)
);

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

const runtimeRelayBaseUrl = () => {
  if (typeof window === 'undefined') return null;
  return window.location.protocol === 'https:'
    ? `${window.location.origin}/yjs/`
    : `http://${window.location.hostname}:${import.meta.env.VITE_YJS_PORT || '1234'}/`;
};

const safeRuntimeImageSource = (value) => {
  if (typeof window === 'undefined') return null;
  return normalizeRuntimeImageSource(value, {
    pageOrigin: window.location.origin,
    relayBaseUrl: runtimeRelayBaseUrl(),
    roomHandle: getActiveRoomSession()?.roomHandle,
  });
};

const safeCustomTemplates = (value) => {
  try {
    return normalizeCustomTemplates(value, Date.now()) || [];
  } catch {
    return [];
  }
};

const useBrowserLayoutEffect = (
  typeof document !== 'undefined' && typeof document.createElement === 'function'
    ? useLayoutEffect
    : useEffect
);

const autoGrownStickyHeight = (height, overflow) => {
  if (!Number.isFinite(overflow) || overflow <= 1) return height;
  return Math.min(STICKY_AUTO_GROW_MAX_H, Math.ceil(height + overflow));
};

const useContentOverflow = (value, enabled = true, layoutKey = '', onOverflow = null) => {
  const elementRef = useRef(null);
  const [overflows, setOverflows] = useState(false);

  useBrowserLayoutEffect(() => {
    const node = elementRef.current;
    if (!node || !enabled) {
      setOverflows(false);
      return undefined;
    }
    const measure = () => {
      const overflow = node.scrollHeight - node.clientHeight;
      setOverflows(overflow > 1);
      if (overflow > 1) onOverflow?.(overflow);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, layoutKey, onOverflow, value]);

  return [elementRef, overflows];
};

// A controlled input normally moves its caret when a remote value replaces
// the DOM value. Keep a selection anchored through the minimal remote change,
// while local keystrokes retain the browser's native selection behaviour.
const CollaborativeTextEditor = ({
  kind = 'textarea', editorRef, value, onValueChange, onContentOverflow, ...props
}) => {
  const elementRef = useRef(null);
  const textValue = String(value ?? '');
  const selectionRef = useRef({ start: textValue.length, end: textValue.length });
  const selectionValueRef = useRef(textValue);

  const assignRef = useCallback((node) => {
    elementRef.current = node;
    if (typeof editorRef === 'function') editorRef(node);
    else if (editorRef) editorRef.current = node;
  }, [editorRef]);

  const rememberSelection = useCallback((node) => {
    if (!node) return;
    selectionRef.current = {
      start: node.selectionStart ?? 0,
      end: node.selectionEnd ?? node.selectionStart ?? 0,
    };
    selectionValueRef.current = node.value;
  }, []);

  useBrowserLayoutEffect(() => {
    const node = elementRef.current;
    const previousValue = selectionValueRef.current;
    if (node && document.activeElement === node && previousValue !== textValue) {
      const change = describeTextReplacement(previousValue, textValue);
      const nextStart = Math.min(
        textValue.length,
        mapSelectionIndexThroughReplacement(selectionRef.current.start, change),
      );
      const nextEnd = Math.min(
        textValue.length,
        mapSelectionIndexThroughReplacement(selectionRef.current.end, change),
      );
      node.setSelectionRange(nextStart, nextEnd);
      selectionRef.current = { start: nextStart, end: nextEnd };
    }
    selectionValueRef.current = textValue;
  }, [textValue]);

  useBrowserLayoutEffect(() => {
    const node = elementRef.current;
    if (!node || kind === 'input' || !onContentOverflow) return;
    onContentOverflow(node.scrollHeight - node.clientHeight);
  }, [kind, onContentOverflow, textValue]);

  const handleChange = useCallback((event) => {
    const node = event.currentTarget;
    rememberSelection(node);
    onValueChange(node.value, {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    });
  }, [onValueChange, rememberSelection]);

  const Element = kind === 'input' ? 'input' : 'textarea';
  return (
    <Element
      {...props}
      ref={assignRef}
      value={textValue}
      onChange={handleChange}
      onSelect={(event) => rememberSelection(event.currentTarget)}
    />
  );
};

const CARD_BADGE_Z = 2;
const CARD_MEDAL_Z = 3;

const StickyCard = React.memo(function StickyCard({
  item, selected, remoteSelected, remoteSelectionHue, isEditing, isOwner, allRevealed, dense, compact,
  voted, voteCount, voteFlash, voteRank, votingAllowedNow, showVoteCount, inZone,
  commentCount, commentPreviews,
  // `lang` is unused inside the body, but its presence as a prop
  // forces a re-render when language changes so t() picks up new strings.
  lang,
  onStartDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur, onToggleVote,
  onOpenComments,
  editAreaRef,
}) {
  void lang;
  const it = item;
  const c = PALETTE[it.color] || PALETTE[0];
  const hideContent = it.private && !allRevealed && !isOwner;
  const visibleText = stickyTextForDom(it, hideContent);
  const w = it.w || STICKY_W;
  const h = it.h || STICKY_H;
  const rot = selected ? 0 : it.rotation;
  const top3 = voteRank != null;
  const [hovered, setHovered] = useState(false);
  const [commentPreviewIndex, setCommentPreviewIndex] = useState(0);
  const commentPreview = commentPreviews[commentPreviewIndex] ?? commentPreviews[0] ?? '';
  const showCommentPreview = !hideContent && !!commentPreview;
  const showCommentEntry = !hideContent && (commentCount > 0 || hovered);
  const overview = compact && w <= 400 && h <= 400
    && !selected && !remoteSelected && !isEditing && !hovered && !top3;
  const growToFit = useCallback((overflow, patch = null) => {
    const nextHeight = autoGrownStickyHeight(h, overflow);
    if (patch) {
      onTextChange(it.id, nextHeight > h ? { ...patch, h: nextHeight } : patch);
    } else if (nextHeight > h) {
      onTextChange(it.id, { h: nextHeight }, { silent: true });
    }
  }, [h, it.id, onTextChange]);
  const [contentRef, contentOverflows] = useContentOverflow(
    visibleText,
    !hideContent && !isEditing && !overview,
    `${it.fontSize || 15}:${h}:${showCommentPreview ? 1 : 0}:${top3 ? 1 : 0}`,
    growToFit,
  );
  useEffect(() => {
    setCommentPreviewIndex(0);
    if (hideContent || overview || commentPreviews.length < 2) return undefined;
    const timer = setInterval(() => {
      setCommentPreviewIndex((index) => (index + 1) % commentPreviews.length);
    }, COMMENT_CAROUSEL_MS);
    return () => clearInterval(timer);
  }, [commentPreviews, hideContent, overview]);
  if (overview) {
    return (
      <div
        className="rb-card-overview"
        onMouseDown={e => onStartDrag(e, it)}
        onDoubleClick={e => { e.stopPropagation(); if (!hideContent) onBeginFocus(it, 'text'); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: 'absolute', left: it.x, top: it.y, width: w, height: h,
          background: c.bg, border: `1.5px solid ${c.border}`, borderRadius: 4,
          padding: 12, boxSizing: 'border-box', contain: 'layout paint style',
          transform: `rotate(${it.rotation || 0}deg)`, cursor: 'grab',
          color: it.fontColor || STICKY_AUTO_TEXT, fontSize: it.fontSize || 15,
          fontFamily: 'var(--font-ui)',
          overflow: 'hidden', userSelect: 'none',
        }}
      >
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: h - 48, overflow: 'hidden' }}>
          {hideContent ? t('sticky.hidden') : visibleText?.slice(0, 200)}
        </div>
        {showVoteCount && !hideContent && (voteCount > 0 || votingAllowedNow) && (
          <button
            type="button"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onToggleVote(it); }}
            disabled={!votingAllowedNow && !voted}
            aria-label={voted ? t('vote.tooltip.unvote') : t('vote.tooltip.vote')}
            style={{ position: 'absolute', right: 8, bottom: 6, border: 'none', borderRadius: 12,
              background: voted ? c.border : 'rgba(0,0,0,0.06)', color: voted ? '#fff' : '#374151',
              padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}
          >{voteCount}</button>
        )}
      </div>
    );
  }
  return (
    <div
      className={remoteSelected ? 'rb-remote-selected-card' : undefined}
      onMouseDown={(e) => { if (!isEditing) onStartDrag(e, it); }}
      onDoubleClick={(e) => { e.stopPropagation(); if (!hideContent) onBeginFocus(it, 'text'); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
        ['--rb-selector-hue']: remoteSelectionHue,
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        animation: remoteSelected
          ? undefined
          : top3
            ? (dense ? 'rb-glow 1.6s ease-in-out infinite' : 'rb-glow 1.6s ease-in-out infinite, rb-appear-rot 0.28s ease-out')
            : (dense ? undefined : 'rb-appear-rot 0.28s ease-out'),
        // Drop the blurred shadow in dense mode — the 1.5px border still
        // separates cards, and overlapping blur is the main cluster paint cost.
        // The top3 glow is kept (only ≤3 cards, meaningful highlight);
        // the medal badge below adds the specific rank on top of it.
        boxShadow: remoteSelected
          ? undefined
          : top3
          ? `0 0 0 3px #fbbf24, 0 8px 24px rgba(251,191,36,0.6), 0 6px 14px rgba(0,0,0,0.12)`
          : (dense ? 'none' : '0 6px 14px rgba(0,0,0,0.12)'),
        cursor: 'grab',
        // Sarabun (Thai) leads so a Thai cluster's consonant + สระ + วรรณยุกต์
        // are shaped by one font — otherwise marks split to a fallback font and
        // detach. Sarabun also covers Latin, so mixed text stays consistent.
        fontFamily: 'var(--font-ui)',
        fontSize: it.fontSize || 15,
        lineHeight: 1.5,
        color: 'var(--text)',
        userSelect: 'none',
        outline: selected ? '2px solid #2563eb' : 'none',
        outlineOffset: 6,
        display: 'flex',
        flexDirection: 'column',
        // Keep the card's own content clipped in its inner regions, but let
        // rank decorations sit across the edge of the physical card.
        overflow: 'visible',
        // Scope paint/layout to this sticky so a hover/vote on one card
        // doesn't trigger repaints of neighbours sharing the same layer.
        // Paint containment clips descendants at the card edge even when
        // overflow is visible. Drop only that containment for winners so the
        // oversized medal can deliberately protrude beyond the card.
        contain: top3 || remoteSelected ? 'layout style' : 'layout paint style',
      }}
    >
      <div style={{
        position: 'absolute', top: 6, right: 6, zIndex: CARD_BADGE_Z,
        width: 'calc(100% - 12px)', display: 'flex', alignItems: 'center',
        justifyContent: 'flex-end', gap: 4, pointerEvents: 'none',
      }}>
        {it.private && !allRevealed && isOwner && (
          <Lock size={14} color={c.border} style={{ flexShrink: 0 }} />
        )}
        {showCommentEntry && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if (!hideContent) onOpenComments(it); }}
            disabled={hideContent}
            title={t('comments.tooltip')}
            aria-label={t('comments.tooltip')}
            style={{
              pointerEvents: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
              minWidth: 28, width: showCommentPreview ? '72%' : 'auto',
              maxWidth: showCommentPreview ? '72%' : (commentCount > 0 ? 54 : 40), height: 26,
              padding: showCommentPreview ? '3px 6px' : '3px 7px',
              background: 'rgba(255,255,255,0.78)', color: '#374151',
              border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8,
              boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
              cursor: hideContent ? 'not-allowed' : 'pointer',
              opacity: hideContent ? 0.45 : (commentCount > 0 ? 0.92 : 0.65),
              overflow: 'hidden',
            }}
          >
            <MessageSquare size={12} style={{ flexShrink: 0 }} />
            {showCommentPreview && (
              <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                <span
                  key={`${commentPreviewIndex}:${commentPreview}`}
                  className={commentPreviews.length > 1 ? 'rb-comment-slide' : undefined}
                  style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {commentPreview}
                </span>
              </span>
            )}
            {commentCount > 0 && (
              <span style={{
                flexShrink: 0, minWidth: 16, height: 16, padding: '0 4px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 999, background: c.border, color: '#fff',
                fontSize: 10, lineHeight: 1,
              }}>
                {commentCount}
              </span>
            )}
          </button>
        )}
      </div>

      {top3 && (
        <div
          title={t('vote.rank', { n: voteRank })}
          style={{
            position: 'absolute', top: -24, left: -24, zIndex: CARD_MEDAL_Z,
            width: 64, height: 64, display: 'grid', placeItems: 'center',
            fontSize: 56,
            filter: 'drop-shadow(0 4px 7px rgba(0,0,0,0.38))',
            lineHeight: 1, pointerEvents: 'none',
          }}
        >
          {MEDAL_BY_RANK[voteRank]}
        </div>
      )}

      <div
        ref={contentRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          position: 'relative',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          // Hidden private text is omitted below, not visually obscured. CSS
          // blur would leave the secret readable in the DOM/accessibility tree.
          userSelect: hideContent ? 'none' : 'auto',
          color: it.fontColor || STICKY_AUTO_TEXT,
          paddingTop: showCommentPreview ? 24 : (top3 ? 16 : 0),
        }}
      >
        {(() => {
          if (hideContent) return null;
          if (isEditing) {
            return (
              <CollaborativeTextEditor
                editorRef={editAreaRef}
                value={it.text || ''}
                maxLength={BOARD_TEXT_MAX_LENGTH}
                onValueChange={(value, metrics) => growToFit(
                  metrics.scrollHeight - metrics.clientHeight,
                  { text: value },
                )}
                onContentOverflow={growToFit}
                onKeyDown={(e) => onTextKeyDown(e)}
                onBlur={() => onTextBlur(it.id)}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder={t('sticky.placeholder')}
                style={{
                  width: '100%', height: '100%',
                  background: 'transparent', border: 'none', outline: 'none',
                  resize: 'none', fontFamily: 'inherit', fontSize: it.fontSize || 15,
                  lineHeight: 1.5, color: it.fontColor || STICKY_AUTO_TEXT,
                  boxSizing: 'border-box', overflowY: 'auto', overflowWrap: 'anywhere',
                }}
              />
            );
          }
          if (visibleText) return visibleText;
          return isOwner
            ? <span style={{ color: STICKY_AUTO_TEXT_FAINT, fontStyle: 'italic' }}>{t('sticky.placeholder')}</span>
            : '';
        })()}
        {contentOverflows && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', right: 0, bottom: 0,
              width: 44, textAlign: 'right', paddingRight: 2,
              background: `linear-gradient(90deg, transparent, ${c.bg} 48%)`,
              color: it.fontColor || STICKY_AUTO_TEXT, fontWeight: 700,
              pointerEvents: 'none',
            }}
          >…</span>
        )}
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
  const c = PALETTE[it.color] || PALETTE[0];
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
          <CollaborativeTextEditor
            kind="input"
            editorRef={editAreaRef}
            value={it.title || ''}
            maxLength={ZONE_TITLE_MAX_LENGTH}
            onValueChange={(value) => onTextChange(it.id, { title: value })}
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
  item, selected, remoteSelected, remoteSelectionHue, isEditing, lang,
  onStartDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur,
  editAreaRef,
}) {
  void lang;
  const it = item;
  return (
    <div
      className={remoteSelected ? 'rb-remote-selected-card' : undefined}
      onMouseDown={(e) => { if (!isEditing) onStartDrag(e, it); }}
      onDoubleClick={(e) => { e.stopPropagation(); onBeginFocus(it, 'text'); }}
      style={{
        position: 'absolute',
        ['--rb-selector-hue']: remoteSelectionHue,
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
        animation: remoteSelected ? undefined : 'rb-appear 0.28s ease-out',
      }}
    >
      {isEditing ? (
        <CollaborativeTextEditor
          editorRef={editAreaRef}
          value={it.text || ''}
          maxLength={BOARD_TEXT_MAX_LENGTH}
          onValueChange={(value) => onTextChange(it.id, { text: value })}
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

const ImageCard = React.memo(function ImageCard({
  item, selected, remoteSelected, remoteSelectionHue, dense, onStartDrag,
}) {
  const it = item;
  const safeSrc = safeRuntimeImageSource(it.src);
  const w = it.w || 200;
  const h = it.h || 200;
  return (
    <div
      className={remoteSelected ? 'rb-remote-selected-card' : undefined}
      onMouseDown={(e) => onStartDrag(e, it)}
      style={{
        position: 'absolute',
        ['--rb-selector-hue']: remoteSelectionHue,
        left: it.x,
        top: it.y,
        width: w,
        height: h,
        // drop-shadow respects PNG alpha but is GPU-expensive; a tight blur
        // radius keeps it cheap when many images are on screen, and dense mode
        // drops it entirely. CSS containment scopes layout/paint invalidation
        // to this card so a change in one image doesn't repaint neighbours.
        filter: remoteSelected || dense ? 'none' : 'drop-shadow(0 3px 6px rgba(0,0,0,0.18))',
        outline: selected ? '2px solid #2563eb' : 'none',
        outlineOffset: 6,
        cursor: 'grab',
        userSelect: 'none',
        animation: remoteSelected || dense ? undefined : 'rb-appear 0.28s ease-out',
        contain: remoteSelected ? 'layout style' : 'layout paint style',
      }}
    >
      {safeSrc && (
        <img
          src={safeSrc}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
        />
      )}
    </div>
  );
});

/* ============================================================
   Image upload prep (shared by paste/drop and legacy-import sanitization)
   ============================================================ */

const canvasToBlob = (canvas, type, quality) => (
  new Promise((resolve) => canvas.toBlob(resolve, type, quality))
);

// Inspect headers before decode so malformed/decompression-bomb inputs are
// rejected early. PNG/JPEG/WebP are always redrawn through a bounded canvas,
// which strips EXIF and other metadata. GIFs retain animation only after a
// full structural/frame-budget check in inspectRasterImageBlob.
const prepareImageBlob = async (blob) => {
  const info = await inspectRasterImageBlob(blob);
  if (!imageInfoIsWithinLimits(info)) return null;
  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = objectUrl;
    });
    let nw = img.naturalWidth;
    let nh = img.naturalHeight;
    if (!Number.isSafeInteger(nw) || !Number.isSafeInteger(nh) || nw < 1 || nh < 1) return null;
    // Browsers apply JPEG orientation while decoding, so a 90-degree EXIF
    // rotation legitimately swaps the dimensions. Any other disagreement
    // means the claimed header and decoded resource do not match.
    const dimensionsMatch = (nw === info.width && nh === info.height)
      || (nw === info.height && nh === info.width);
    if (!dimensionsMatch) return null;

    if (info.mime === 'image/gif') return { blob, nw, nh };

    const maxEdge = Math.max(nw, nh);
    const scale = Math.min(1, IMAGE_OUTPUT_MAX_DIMENSION / maxEdge);
    const cw = Math.max(1, Math.round(nw * scale));
    const ch = Math.max(1, Math.round(nh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cw, ch);

    let finalBlob = await canvasToBlob(
      canvas,
      info.mime,
      info.mime === 'image/png' ? undefined : 0.85,
    );
    nw = cw;
    nh = ch;
    if (!finalBlob || !isSafeImageMime(finalBlob.type) || finalBlob.size > IMAGE_MAX_BYTES) {
      // A lossless canvas encoding can grow beyond the input cap. Fall back
      // to bounded JPEG output; this intentionally drops transparency.
      finalBlob = await canvasToBlob(canvas, 'image/jpeg', 0.8);
    }
    if (!finalBlob || finalBlob.type !== 'image/jpeg' && finalBlob.type !== info.mime
      || finalBlob.size < 1 || finalBlob.size > IMAGE_MAX_BYTES) return null;
    return { blob: finalBlob, nw, nh };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

// Read only validated image routes. Room reads refresh the authenticated
// session through the same transport as uploads.
const readBackupImage = async (source) => {
  const src = safeRuntimeImageSource(source);
  if (!src) throw new Error('image belongs to another room or server');
  const path = new URL(src).pathname;
  const roomImage = path.match(/^\/(?:yjs\/)?rooms\/[A-Za-z0-9_-]{32}\/(images\/[^/]+)$/);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = roomImage
      ? await roomFetch(roomImage[1])
      : await fetch(src, { credentials: 'include', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (response.ok) return response.blob();
    const status = response.status;
    await response.body?.cancel();
    if (status !== 429 || attempt === 5) throw new Error(`image read failed: ${status}`);
    await new Promise(resolve => { setTimeout(resolve, 1100); });
  }
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

// Embedded backup images are uploaded before the board's one Yjs update,
// keeping the update small. Do not replace live state if any image fails.
const sanitizeImportedImages = (items, readImageBlob) => restoreBackupImages(items, {
  readImage: readBackupImage,
  readImageBlob,
  prepareImage: prepareImageBlob,
  uploadImage: uploadWithRetry,
  resolveSource: safeRuntimeImageSource,
});

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
  const renderedViewportRef = useRef(viewport);
  const viewportCullCommitAtRef = useRef(0);
  const wheelCommitRef = useRef(null);
  const wheelRafRef = useRef(null);
  const wheelQueueRef = useRef([]);
  useEffect(() => {
    renderedViewportRef.current = viewport;
    if (interactionRef.current === null && wheelCommitRef.current == null
      && wheelRafRef.current == null && !followedUserIdRef.current) viewportRef.current = viewport;
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
  const [remoteEditingItems, setRemoteEditingItems] = useState(() => storage.getRemoteEditingItems());
  const [remoteSelectedItems, setRemoteSelectedItems] = useState(() => storage.getRemoteSelectedItems());

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
  const [commentsByItem, setCommentsByItem] = useState(() => (
    typeof window !== 'undefined' && window.storage?.snapshotComments
      ? window.storage.snapshotComments()
      : new Map()
  ));
  const commentPreviewCacheRef = useRef(new Map());
  const [creationMode, setCreationMode] = useState(null); // 'zone' | 'select' | null
  const clipboardRef = useRef(null);
  const fileDragPointRef = useRef(null);
  const [zonePreview, setZonePreview] = useState(null); // {x,y,w,h} in world coords
  const creationModeRef = useRef(null);
  useEffect(() => { creationModeRef.current = creationMode; }, [creationMode]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [timerSetupOpen, setTimerSetupOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [playerListOpen, setPlayerListOpen] = useState(false);
  const [followedUserId, setFollowedUserId] = useState(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [fontColorOpen, setFontColorOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [commentsOpenFor, setCommentsOpenFor] = useState(null);
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
  const [confirmUnlockAll, setConfirmUnlockAll] = useState(false);
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
  const worldMeasureRef = useRef(null);
  const gridRef = useRef(null);
  const cursorLayerRef = useRef(null);
  const cursorLastSentAtRef = useRef(0);
  const cursorPendingRef = useRef(null);
  const cursorBroadcastTimerRef = useRef(null);
  const viewLastSentAtRef = useRef(0);
  const viewPendingRef = useRef(null);
  const viewBroadcastTimerRef = useRef(null);
  const viewLastPublishedRef = useRef(null);
  const followedUserIdRef = useRef(null);
  const followViewportCommitRef = useRef(null);
  const followLastCommitAtRef = useRef(0);
  const followMotionFrameRef = useRef(null);
  const followMotionPlayerRef = useRef(null);
  const followMotionSignatureRef = useRef('');
  const minimapPanelRef = useRef(null);
  const minimapViewportRef = useRef(null);
  const minimapModelRef = useRef(null);
  const minimapHideTimerRef = useRef(null);
  const minimapActivityAtRef = useRef(0);
  const saveTimerRef = useRef(null);
  const interactionRef = useRef(null);
  const editAreaRef = useRef(null);
  // Ids of items currently being dragged/resized locally — protected from remote overwrite of geometry.
  const dragItemsRef = useRef(null);
  const activeGeometryFinalizerRef = useRef(null);
  const activeViewportFinalizerRef = useRef(null);
  useEffect(() => { followedUserIdRef.current = followedUserId; }, [followedUserId]);
  useEffect(() => () => {
    activeGeometryFinalizerRef.current?.();
    activeViewportFinalizerRef.current?.();
    storage.setLocalBusyItems('geometry', []);
    storage.setLocalBusyItems('text', []);
    storage.setLocalSelectedItems([]);
    if (cursorBroadcastTimerRef.current != null) clearTimeout(cursorBroadcastTimerRef.current);
    if (viewBroadcastTimerRef.current != null) clearTimeout(viewBroadcastTimerRef.current);
    if (followViewportCommitRef.current != null) clearTimeout(followViewportCommitRef.current);
    if (followMotionFrameRef.current != null) cancelAnimationFrame(followMotionFrameRef.current);
    window.storage?.setLocalCursor?.(null);
    window.storage?.setLocalView?.(null);
  }, []);

  /* ---------- Derived ---------- */
  // Awareness owns liveness and expires peers using receiver-local time.
  // Comparing sender lastSeen to our clock made connected players flicker.
  const onlineUsers = useMemo(() => Object.values(presence), [presence]);

  const playerCursors = useMemo(() => visiblePlayerCursors({
    presence,
    currentUserId: userId,
    now,
  }), [presence, userId, now]);

  const followedPlayer = followedUserId
    ? onlineUsers.find((player) => player.userId === followedUserId) || null
    : null;
  const followedCursor = followedUserId
    ? playerCursors.find((player) => player.userId === followedUserId) || null
    : null;
  const followedView = Number.isFinite(followedPlayer?.view?.x)
    && Number.isFinite(followedPlayer?.view?.y)
    ? followedPlayer.view
    : null;

  const remoteEditorsByItem = useMemo(
    () => summarizeRemoteEditors(remoteEditingItems),
    [remoteEditingItems],
  );

  const remoteSelectorsByItem = useMemo(
    () => summarizeRemoteSelectors(remoteSelectedItems),
    [remoteSelectedItems],
  );

  const editingIndicators = useMemo(() => board.items.flatMap((item) => {
    const editor = remoteEditorsByItem.get(item.id);
    return editor ? [{ item, editor }] : [];
  }), [board.items, remoteEditorsByItem]);

  const selectionIndicators = useMemo(() => board.items.flatMap((item) => {
    if (item.type === 'zone') return [];
    const selector = remoteSelectorsByItem.get(item.id);
    return selector ? [{ item, selector }] : [];
  }), [board.items, remoteSelectorsByItem]);

  useEffect(() => {
    if (!loaded) return undefined;
    const refresh = (event) => {
      const next = event?.detail instanceof Map
        ? event.detail
        : storage.getRemoteEditingItems();
      setRemoteEditingItems(new Map(next));
    };
    refresh();
    const unsubscribe = storage.onEditingChange(refresh);
    return () => unsubscribe?.();
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return undefined;
    const refresh = (event) => {
      const next = event?.detail instanceof Map
        ? event.detail
        : storage.getRemoteSelectedItems();
      setRemoteSelectedItems(new Map(next));
    };
    refresh();
    const unsubscribe = storage.onSelectionChange(refresh);
    return () => unsubscribe?.();
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    storage.setLocalSelectedItems(selectedIds);
  }, [loaded, selectedIds]);

  const sortedItems = useMemo(() => {
    return board.items
      .filter((item) => geometryErrorForItem(item) == null)
      .sort(compareZOrder);
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
  const [compactRender, setCompactRender] = useState(false);
  useEffect(() => {
    let timer;
    const settleDetails = () => {
      // Culling snapshots change during a gesture, but card structure must
      // not switch back and forth as zoom crosses the overview threshold.
      if (wheelCommitRef.current != null || wheelRafRef.current != null
        || interactionRef.current !== null) {
        timer = setTimeout(settleDetails, 120);
        return;
      }
      setCompactRender(denseRender && viewportRef.current.zoom < 0.4);
    };
    settleDetails();
    return () => clearTimeout(timer);
  }, [denseRender, viewport.zoom]);

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

  const minimapModel = useMemo(() => buildMinimapModel({
    items: sortedItems,
    viewport,
    viewportSize,
    width: MINIMAP_W,
    height: MINIMAP_H,
  }), [sortedItems, viewport, viewportSize]);
  minimapModelRef.current = minimapModel;

  const revealMinimap = useCallback(() => {
    const panel = minimapPanelRef.current;
    if (!panel) return;
    panel.style.opacity = '1';
    panel.style.pointerEvents = 'auto';
    if (minimapHideTimerRef.current != null) clearTimeout(minimapHideTimerRef.current);
    const hideWhenIdle = () => {
      const currentPanel = minimapPanelRef.current;
      if (!currentPanel) return;
      const hasFocus = currentPanel.contains(document.activeElement);
      const isHovered = currentPanel.matches(':hover');
      if (hasFocus || isHovered || interactionRef.current?.kind === 'minimap') {
        minimapHideTimerRef.current = setTimeout(hideWhenIdle, MINIMAP_IDLE_MS);
        return;
      }
      currentPanel.style.opacity = '0';
      currentPanel.style.pointerEvents = 'none';
      minimapHideTimerRef.current = null;
    };
    minimapHideTimerRef.current = setTimeout(hideWhenIdle, MINIMAP_IDLE_MS);
  }, []);

  const flushLocalCursor = useCallback(() => {
    cursorBroadcastTimerRef.current = null;
    const point = cursorPendingRef.current;
    cursorPendingRef.current = null;
    if (!point) return;
    cursorLastSentAtRef.current = performance.now();
    window.storage?.setLocalCursor?.(point);
  }, []);

  const publishLocalCursor = useCallback((point) => {
    cursorPendingRef.current = point;
    const elapsed = performance.now() - cursorLastSentAtRef.current;
    if (elapsed >= CURSOR_BROADCAST_MS) {
      if (cursorBroadcastTimerRef.current != null) {
        clearTimeout(cursorBroadcastTimerRef.current);
        cursorBroadcastTimerRef.current = null;
      }
      flushLocalCursor();
      return;
    }
    if (cursorBroadcastTimerRef.current == null) {
      cursorBroadcastTimerRef.current = setTimeout(flushLocalCursor, CURSOR_BROADCAST_MS - elapsed);
    }
  }, [flushLocalCursor]);

  const clearLocalCursor = useCallback(() => {
    cursorPendingRef.current = null;
    if (cursorBroadcastTimerRef.current != null) {
      clearTimeout(cursorBroadcastTimerRef.current);
      cursorBroadcastTimerRef.current = null;
    }
    window.storage?.setLocalCursor?.(null);
  }, []);

  const flushLocalView = useCallback(() => {
    viewBroadcastTimerRef.current = null;
    const view = viewPendingRef.current;
    viewPendingRef.current = null;
    if (!view) return;
    viewLastSentAtRef.current = performance.now();
    viewLastPublishedRef.current = view;
    window.storage?.setLocalView?.(view);
  }, []);

  const publishLocalView = useCallback((viewportValue) => {
    const view = playerViewFromViewport(viewportValue, viewportSize);
    if (!view) return;
    const previous = viewLastPublishedRef.current;
    if (previous
      && Math.abs(previous.x - view.x) < 0.05
      && Math.abs(previous.y - view.y) < 0.05
      && Math.abs(previous.zoom - view.zoom) < 0.0001) {
      viewPendingRef.current = null;
      if (viewBroadcastTimerRef.current != null) {
        clearTimeout(viewBroadcastTimerRef.current);
        viewBroadcastTimerRef.current = null;
      }
      return;
    }
    viewPendingRef.current = view;
    const elapsed = performance.now() - viewLastSentAtRef.current;
    if (elapsed >= CURSOR_BROADCAST_MS) {
      if (viewBroadcastTimerRef.current != null) {
        clearTimeout(viewBroadcastTimerRef.current);
        viewBroadcastTimerRef.current = null;
      }
      flushLocalView();
      return;
    }
    if (viewBroadcastTimerRef.current == null) {
      viewBroadcastTimerRef.current = setTimeout(flushLocalView, CURSOR_BROADCAST_MS - elapsed);
    }
  }, [flushLocalView, viewportSize]);

  useEffect(() => {
    if (!loaded || followedUserIdRef.current) return;
    publishLocalView(viewport);
  }, [loaded, viewport, viewportSize, publishLocalView]);

  const onCanvasPointerActivity = useCallback((e) => {
    const timestamp = performance.now();
    if (timestamp - minimapActivityAtRef.current >= 180) {
      minimapActivityAtRef.current = timestamp;
      revealMinimap();
    }
    if (e.pointerType === 'touch') return;
    const v = viewportRef.current;
    publishLocalCursor({
      x: (e.clientX - v.x) / v.zoom,
      y: (e.clientY - v.y) / v.zoom,
    });
  }, [publishLocalCursor, revealMinimap]);

  useEffect(() => {
    window.addEventListener('blur', clearLocalCursor);
    return () => window.removeEventListener('blur', clearLocalCursor);
  }, [clearLocalCursor]);

  useEffect(() => () => {
    if (minimapHideTimerRef.current != null) clearTimeout(minimapHideTimerRef.current);
  }, []);

  // Snapped viewport — quantize pan/zoom so small movements don't invalidate
  // the visibleItems memo. The actual transform still uses the live viewport;
  // this only stabilises the culling decision.
  const cullX = Math.floor(viewport.x / 200) * 200;
  const cullY = Math.floor(viewport.y / 200) * 200;
  const cullZoom = Math.round(viewport.zoom * 20) / 20;
  const cullViewport = useMemo(() => ({ x: cullX, y: cullY, zoom: cullZoom }), [cullX, cullY, cullZoom]);

  // Only render items whose AABB intersects the visible world rect (with a
  // generous margin so items don't pop in at the edge during pan/zoom). The
  // margin is wider than the snap step so culling lines never bite.
  const visibleItems = useMemo(() => {
    const z = cullViewport.zoom;
    const wx0 = -cullViewport.x / z;
    const wy0 = -cullViewport.y / z;
    const wx1 = (viewportSize.w - cullViewport.x) / z;
    const wy1 = (viewportSize.h - cullViewport.y) / z;
    const margin = (z < 0.4 ? 320 : 600) / z;
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
  const commentCountOf = useCallback((id) => commentsByItem.get(id)?.length ?? 0, [commentsByItem]);
  const commentPreviewsByItem = useMemo(() => {
    const previous = commentPreviewCacheRef.current;
    const previews = new Map();
    commentsByItem.forEach((comments, itemId) => {
      const entries = [...comments]
        .reverse()
        .map((comment) => {
          const text = String(comment.text || '').replace(/\s+/g, ' ').trim();
          return text.length > COMMENT_PREVIEW_TEXT_LIMIT
            ? `${text.slice(0, COMMENT_PREVIEW_TEXT_LIMIT).trimEnd()}…`
            : text;
        })
        .filter(Boolean);
      if (entries.length) {
        const cached = previous.get(itemId);
        const unchanged = cached
          && cached.length === entries.length
          && cached.every((text, index) => text === entries[index]);
        previews.set(itemId, unchanged ? cached : entries);
      }
    });
    return previews;
  }, [commentsByItem]);
  useEffect(() => {
    commentPreviewCacheRef.current = commentPreviewsByItem;
  }, [commentPreviewsByItem]);

  // Map of stickyId -> rank (1, 2, or 3) once its zone's results are finalized.
  // A finished root gets one shared podium across all nested zones — never a
  // separate #1/#2/#3 per child. Drives both the glow and medal badge.
  const topVotedRanks = useMemo(() => {
    return buildTopVotedRanks({
      items: board.items,
      voteCountOf,
      groupIdsForZone: zoneGroupIds,
      ownerZoneForItem: effectiveOwnerZone,
      zoneHasActiveGovernor,
    });
  }, [board, voteCountOf]);

  /* ============================================================
     Load identity + initial board
     ============================================================ */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uRec = await storage.get('userId', false);
      let id = normalizeStoredUserId(uRec?.value);
      if (!id) {
        id = uid();
        await storage.set('userId', id, false);
      }
      const nRec = await storage.get('userName', false);
      const name = normalizeDisplayName(nRec?.value);
      if (nRec?.value !== name) await storage.set('userName', name, false);

      const vRec = await storage.get('viewport', false);
      const vp = normalizeViewport(vRec?.value);
      if (JSON.stringify(vRec?.value) !== JSON.stringify(vp)) {
        await storage.set('viewport', vp, false);
      }

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
      setCustomTemplates(safeCustomTemplates(tpls));
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
  const lastWriteFailureRef = useRef(0);
  const reportWriteFailure = useCallback(() => {
    const nowMs = Date.now();
    if (nowMs - lastWriteFailureRef.current < 3000) return;
    lastWriteFailureRef.current = nowMs;
    setToast({ msg: t('common.saveFailed'), type: 'warn' });
  }, []);

  // ---- One-item field patch ----
  const updateItem = useCallback((id, patch, opts) => {
    if (!storage.updateItem(id, patch, opts)) { reportWriteFailure(); return false; }
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    }));
    return true;
  }, [reportWriteFailure]);

  // ---- Add one / many new items ----
  const addItemLocal = useCallback((item) => {
    if (!storage.addItem(item)) { reportWriteFailure(); return false; }
    setBoard((prev) => ({ ...prev, items: [...prev.items, item] }));
    return true;
  }, [reportWriteFailure]);

  const addItemsLocal = useCallback((items) => {
    if (!items.length || !storage.addItems(items)) { reportWriteFailure(); return false; }
    setBoard((prev) => ({ ...prev, items: [...prev.items, ...items] }));
    return true;
  }, [reportWriteFailure]);

  // ---- Board-level meta patch ----
  const patchMeta = useCallback((patch, opts) => {
    if (!storage.setMeta(patch, opts)) { reportWriteFailure(); return false; }
    setBoard((prev) => ({ ...prev, ...patch }));
    return true;
  }, [reportWriteFailure]);

  const {
    isAdmin, canClaim, pinPromptCfg, requireAdminPin, adminClaim, adminTransfer,
  } = useAdminRole({
    userId, userName, board, boardRef, onlineUsers, presence,
    boardCode, boardToken, patchMeta, setToast, storage,
  });

  // ---- Full board replace (import / clear) ----
  const replaceBoardLocal = useCallback((nextBoard, opts) => {
    if (!storage.replaceBoard(nextBoard, opts)) { reportWriteFailure(); return false; }
    setBoard(nextBoard);
    return true;
  }, [reportWriteFailure]);

  /* ----- Throttled geometry writer for drag / resize -----
     Optimistic setBoard runs every frame for a live local feel; the granular
     Yjs write is throttled to DRAG_FLUSH_MS with a DRAG_TRAILING_MS trailing
     flush. `pendingGeomRef` always holds the freshest entries, so timing
     against React's commit cycle is irrelevant. */
  const flushPendingGeom = useCallback(() => {
    const entries = pendingGeomRef.current;
    if (entries && entries.length && !storage.updateItems(entries)) {
      reportWriteFailure();
      storage.get('boardState', true).then((record) => {
        if (record?.value) setBoard({ ...DEFAULT_BOARD, ...record.value });
      });
    }
    lastFlushRef.current = Date.now();
  }, [reportWriteFailure]);

  const commitGeometry = useCallback((entries) => {
    // Single enforcement point for "locked zones don't move" — every drag/
    // resize path (solo, group, zone-carries-children) funnels through here,
    // so filtering here also covers a locked zone caught in someone else's
    // multi-select drag, not just its own title bar / resize handles.
    //
    // A locked zone should still be carried along when a larger unlocked
    // ANCESTOR zone is the one being dragged — lock means "don't let a user
    // grab/resize this zone directly", not "detach it from its parent's
    // movement". A locked zone's patch is allowed only when ALL of:
    //   - it's a pure x/y move (no w/h — resize never gets a pass, otherwise
    //     a group-resize could still rescale a locked nested zone), and
    //   - its immediate owner zone also has a patch in this same batch, and
    //   - that owner is itself allowed to move (checked recursively, so a
    //     locked zone under another locked, non-moving zone stays put too —
    //     the owner's mere presence in the batch isn't proof it's moving,
    //     since the owner itself may get filtered out).
    const itemById = new Map(boardRef.current.items.map((i) => [i.id, i]));
    const patchById = new Map(entries.map((e) => [e.id, e.patch]));
    const isPureMove = (patch) => !('w' in patch) && !('h' in patch);
    const allowedCache = new Map();
    const isAllowed = (id) => {
      if (allowedCache.has(id)) return allowedCache.get(id);
      allowedCache.set(id, false); // guards a cyclic parentZoneId chain
      const it = itemById.get(id);
      let result = true;
      if (it?.type === 'zone' && it.locked) {
        const patch = patchById.get(id);
        const parent = patch && isPureMove(patch) ? effectiveOwnerZone(it, boardRef.current.items) : null;
        result = !!(parent && patchById.has(parent.id) && isAllowed(parent.id));
      }
      allowedCache.set(id, result);
      return result;
    };
    const filtered = entries.filter((e) => isAllowed(e.id));
    if (!filtered.length) return;
    if (filtered.some((e) => {
      const current = itemById.get(e.id);
      return !current || geometryErrorForPatch(current, e.patch);
    })) { reportWriteFailure(); return; }
    const byId = new Map(filtered.map((e) => [e.id, e.patch]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (byId.has(it.id) ? { ...it, ...byId.get(it.id) } : it)),
    }));
    pendingGeomRef.current = filtered;
    if (Date.now() - lastFlushRef.current >= DRAG_FLUSH_MS) flushPendingGeom();
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPendingGeom, DRAG_TRAILING_MS);
  }, [flushPendingGeom, reportWriteFailure]);

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
      const dragIds = dragItemsRef.current; // Set<id> or null
      const remoteIds = new Set(next.items.map((i) => i.id));
      // Prune expired entries so a stale grace-period record can't outlive
      // its window and mask a genuine later remote change to the same item.
      const recentlyMoved = recentlyMovedRef.current;
      const nowMs = Date.now();
      recentlyMoved.forEach((v, id) => { if (v.until <= nowMs) recentlyMoved.delete(id); });
      if ((dragIds && dragIds.size > 0) || recentlyMoved.size > 0) {
        // Index prev items by id once (O(N)) so the merge below is O(N), not the
        // O(N²) a per-item find() would cost during live collaboration.
        const prevById = new Map(prev.items.map((p) => [p.id, p]));
        next.items = next.items.map((i) => {
          const localItem = prevById.get(i.id);
          if (!localItem) return i;
          let patched = i;
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
      // applyRemoteBoard preserves geometry for items in dragItemsRef, while
      // collaborative Y.Text snapshots are always applied so simultaneous
      // editors see the merged text on every remote keystroke.
      if (key === 'boardState') applyRemoteBoard(value, isUndoRedo);
      else if (key === 'presence') setPresence(value || {});
      else if (key === 'customTemplates') setCustomTemplates(safeCustomTemplates(value));
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
    const commentHandler = () => {
      if (typeof window !== 'undefined' && window.storage?.snapshotComments) {
        setCommentsByItem(window.storage.snapshotComments());
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
        if (Array.isArray(r?.value)) setCustomTemplates(safeCustomTemplates(r.value));
      });
      voteHandler();
      commentHandler();
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
      commentHandler();
    };
    const interval = setInterval(safetyTick, POLL_SAFETY);
    if (typeof window !== 'undefined' && window.storage?.onVotesChange) {
      window.storage.onVotesChange(voteHandler);
    }
    if (typeof window !== 'undefined' && window.storage?.onCommentsChange) {
      window.storage.onCommentsChange(commentHandler);
    }
    return () => {
      stopped = true;
      if (typeof storage.off === 'function') storage.off(handler);
      if (typeof window !== 'undefined' && window.storage?.offVotesChange) {
        window.storage.offVotesChange(voteHandler);
      }
      if (typeof window !== 'undefined' && window.storage?.offCommentsChange) {
        window.storage.offCommentsChange(commentHandler);
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
     `now` also gates cursor freshness, and heartbeats fire every
     5s anyway. Cuts idle parent re-renders 5x.
     ============================================================ */
  const tickInterval = board.items.some((i) => i.type === 'zone' && i.voteTimer?.endsAt) ? 1000 : 5000;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickInterval);
    return () => clearInterval(id);
  }, [tickInterval]);

  // Reposition sticky notes within their innermost containing zone, preserving
  // category membership while ordering each layout by vote count. Medal ranks
  // are computed once across the largest session zone by topVotedRanks above.
  // Shared by both ways a voting session can end: deadline or admin stop.
  const finalizeVotingSession = useCallback((zoneId) => {
    const b = boardRef.current;
    const rootZone = b.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!rootZone?.voteTimer) return;
    const plan = planVoteFinalization(b.items, votesByItem, zoneId, Date.now());
    if (!plan) return;
    if (plan.entries.length > 1) {
      // The sort is an authoritative reposition — it must win over any
      // grace-period protection a prior drag left on these same ids,
      // otherwise the self-echoed 'system' write below gets reverted back
      // to the pre-sort dragged position by the recentlyMoved guard.
      plan.entries.forEach((e) => recentlyMovedRef.current.delete(e.id));
    }
    if (!storage.updateItems(plan.entries, { silent: true })) {
      reportWriteFailure();
      return;
    }
    const patchById = new Map(plan.entries.map((entry) => [entry.id, entry.patch]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((item) => (
        patchById.has(item.id) ? { ...item, ...patchById.get(item.id) } : item
      )),
    }));
    let totalVotes = 0;
    const voters = new Set();
    const votesByUser = new Map();
    plan.stickies
      .filter((s) => plan.zoneIds.has(plan.ownerByStickyId.get(s.id)))
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
  }, [votesByItem, onlineUsers, t, reportWriteFailure]);

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
    if (!isAdmin && boardRef.current.editingLocked) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return;
    }
    if (!window.storage?.undo?.()) setToast({ msg: t('topbar.nothingToUndo'), type: 'warn' });
  }, [isAdmin, t]);
  const doRedo = useCallback(() => {
    if (midDrag()) { setToast({ msg: t('topbar.finishDragFirst'), type: 'warn' }); return; }
    if (!isAdmin && boardRef.current.editingLocked) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return;
    }
    if (!window.storage?.redo?.()) setToast({ msg: t('topbar.nothingToRedo'), type: 'warn' });
  }, [isAdmin, t]);

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
    // One Yjs transaction so Cmd+Z restores the item and its related state together.
    // Falls back to the two-call path if the bridge is an older build that
    // doesn't expose the combined helper yet.
    if (window.storage?.deleteItemWithVotesAndComments) {
      window.storage.deleteItemWithVotesAndComments(id);
      // React state still needs to drop the item — the deepObserver fires a
      // synthetic boardState change, but only for non-local origins. Our own
      // delete is 'local', so do it explicitly here.
      setBoard((prev) => ({ ...prev, items: prev.items.filter((it) => it.id !== id) }));
    } else {
      window.storage?.clearVotesFor?.(id);
      window.storage?.clearCommentsForItems?.([id]);
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
      : Math.floor(Math.random() * PALETTE.length);
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
    if (!isSafeImageMime(blob.type)) {
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
    let prepared;
    try {
      prepared = await prepareImageBlob(blob);
    } catch {
      prepared = null;
    }
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
    const name = (rawName || '').trim().slice(0, TEMPLATE_NAME_MAX_LENGTH);
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
    let next;
    try {
      next = normalizeCustomTemplates([
        ...customTemplates,
        { id: uid(), name, zones: normalized, createdAt: Date.now() },
      ]);
    } catch (err) {
      setToast({ msg: err.message, type: 'warn' });
      return;
    }
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

  const votingTimerPhase = useMemo(
    () => voteTimerPhaseSignature(board.items, now),
    [board.items, now],
  );

  const stickyVotingContext = useMemo(() => {
    const map = new Map();
    const stickies = board.items.filter((i) => i.type === 'sticky');
    stickies.forEach((s) => {
      const zone = effectiveOwnerZone(s, board.items);
      const voteZone = activeVoteZone(s, board.items, now);
      const voteTimer = voteZone?.voteTimer;
      map.set(s.id, {
        votingAllowedNow: !!voteZone && !voteZone.votingLocked,
        // "Hide counts" is session-wide, including the admin who started it.
        // Results become visible to everyone again as soon as the session ends.
        hideVoteCounts: !!voteTimer?.hideResults,
        revealed: effectiveRevealed(s, board.items, board.allRevealed),
        inZone: !!zone,
      });
    });
    return map;
    // The compact phase signature changes only when a timer crosses its
    // deadline, so active timers do not rebuild every sticky once per second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneVotingSignature, votingTimerPhase, board.allRevealed]);

  const requireEdit = useCallback(() => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
    return true;
  }, [editingAllowed]);

  const unlockSelectedItems = useCallback(() => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return;
    }
    const entries = unlockEntriesForSelection(boardRef.current.items, selectedIdsRef.current);
    if (!entries.length) return;
    if (!storage.updateItems(entries)) { reportWriteFailure(); return; }
    const unlockedIds = new Set(entries.map((entry) => entry.id));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((item) => (
        unlockedIds.has(item.id) ? { ...item, locked: false } : item
      )),
    }));
    setToast({ msg: t('selection.unlockAll.done', { n: entries.length }), type: 'info' });
  }, [editingAllowed, t, reportWriteFailure]);

  const requireMove = useCallback((candidateIds) => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
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
  }, [editingAllowed]);

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

  const openComments = useCallback((item) => {
    setCommentsOpenFor(item.id);
  }, []);

  const addCommentTo = useCallback((item, text) => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed || !window.storage?.addComment) return false;
    return window.storage.addComment(item.id, {
      id: uid(),
      authorId: userId,
      authorName: userName,
      text: trimmed,
      createdAt: Date.now(),
    });
  }, [editingAllowed, userId, userName, t]);

  const deleteCommentFrom = useCallback((itemId, commentId) => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return;
    }
    window.storage?.deleteComment?.(itemId, commentId);
  }, [editingAllowed, t]);

  const commentsOpenItem = useMemo(
    () => (commentsOpenFor
      ? board.items.find((candidate) => candidate.id === commentsOpenFor) ?? null
      : null),
    [commentsOpenFor, board.items],
  );
  const commentsOpenReadable = !!commentsOpenItem && !isStickyHiddenForUser(
    commentsOpenItem, board.items, board.allRevealed, userId,
  );

  // A remote zone-hide or item deletion must revoke an already-open comment
  // view. Depend on the derived boolean so unrelated board updates do not
  // repeatedly run this synchronization effect.
  useEffect(() => {
    if (commentsOpenFor && !commentsOpenReadable) setCommentsOpenFor(null);
  }, [commentsOpenFor, commentsOpenReadable]);

  /* ============================================================
     Interactions: pan, zoom, drag, resize
     ============================================================ */

  // Apply a viewport directly to the DOM, bypassing React. Used during pan so
  // a board with hundreds of cards doesn't run the React commit phase on every
  // mousemove — pan becomes a single GPU-composited transform.
  const applyViewportToDom = useCallback((v) => {
    revealMinimap();
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    }
    if (gridRef.current) {
      const s = GRID_PITCH_PX * v.zoom;
      gridRef.current.style.backgroundSize = `${s}px ${s}px`;
      gridRef.current.style.backgroundPosition = `${v.x}px ${v.y}px`;
    }
    if (cursorLayerRef.current) {
      Array.from(cursorLayerRef.current.children).forEach((node) => {
        const point = cursorScreenPosition({
          x: Number(node.dataset.cursorX),
          y: Number(node.dataset.cursorY),
        }, v);
        node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
      });
    }
    if (minimapViewportRef.current && minimapModelRef.current) {
      const model = minimapModelRef.current;
      const miniView = minimapViewportRect(v, model.viewportSize, model);
      minimapViewportRef.current.style.transform = `translate3d(${miniView.x}px, ${miniView.y}px, 0)`;
      minimapViewportRef.current.style.width = `${miniView.w}px`;
      minimapViewportRef.current.style.height = `${miniView.h}px`;
    }
  }, [revealMinimap]);

  // Keep the DOM in sync with React state for non-live changes (fit, reset,
  // initial load). Continuous wheel/pan input applies directly to the DOM,
  // and its final commit brings React state back into sync.
  useEffect(() => {
    if (interactionRef.current === null && wheelCommitRef.current == null
      && wheelRafRef.current == null && !followedUserIdRef.current) applyViewportToDom(viewport);
  }, [viewport, applyViewportToDom]);

  const liveApplyViewport = useCallback((next, { broadcastView = true } = {}) => {
    viewportRef.current = next;
    applyViewportToDom(next);
    if (broadcastView) publishLocalView(next);
    // Refresh culling during long gestures without reconciling on every input
    // frame. Otherwise newly reached objects stay blank until mouseup.
    const rendered = renderedViewportRef.current;
    const nowMs = performance.now();
    if (nowMs - viewportCullCommitAtRef.current >= 100
      && viewportNeedsCullRefresh(rendered, next, viewportSize)) {
      viewportCullCommitAtRef.current = nowMs;
      // The transform is already current. Let input frames preempt the
      // more expensive React work that mounts newly visible cards.
      startTransition(() => setViewport(next));
    }
  }, [applyViewportToDom, publishLocalView, viewportSize]);

  // Wheel input is the noisiest input on the page — trackpads / Magic Mice
  // can fire 120+ events/sec. Each event used to force a layout via
  // getBoundingClientRect and write to the DOM, which manifested as zoom
  // jitter. Coalesce events into one rAF tick: cache rect once, fold every
  // queued delta on top of the current viewport, then write the final
  // transform once per frame.
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

  const stopFollowing = useCallback(() => {
    if (!followedUserIdRef.current) return;
    followedUserIdRef.current = null;
    followMotionPlayerRef.current = null;
    followMotionSignatureRef.current = '';
    setFollowedUserId(null);
    if (followViewportCommitRef.current != null) {
      clearTimeout(followViewportCommitRef.current);
      followViewportCommitRef.current = null;
    }
    setViewport(viewportRef.current);
  }, []);

  const startFollowing = useCallback((targetUserId) => {
    if (!targetUserId || targetUserId === userIdRef.current) return;
    if (followViewportCommitRef.current != null) {
      clearTimeout(followViewportCommitRef.current);
      followViewportCommitRef.current = null;
    }
    followedUserIdRef.current = targetUserId;
    followMotionSignatureRef.current = '';
    followLastCommitAtRef.current = 0;
    setFollowedUserId(targetUserId);
    setPlayerListOpen(false);
  }, []);

  useEffect(() => {
    if (!followedUserId) return;
    if (!followedPlayer) {
      stopFollowing();
      setToast({ msg: t('follow.ended'), type: 'info' });
      return;
    }
    const targetPoint = followedView || followedCursor?.cursor;
    if (!targetPoint) return;

    const next = centerViewportOnWorld(
      {
        ...viewportRef.current,
        zoom: followedPlayer.view?.zoom || viewportRef.current.zoom,
      },
      viewportSize,
      targetPoint,
    );
    liveApplyViewport(next, { broadcastView: false });

    const timestamp = performance.now();
    const elapsed = timestamp - followLastCommitAtRef.current;
    const commit = () => {
      followViewportCommitRef.current = null;
      followLastCommitAtRef.current = performance.now();
      setViewport(viewportRef.current);
    };
    if (elapsed >= FOLLOW_VIEWPORT_COMMIT_MS) {
      if (followViewportCommitRef.current != null) clearTimeout(followViewportCommitRef.current);
      commit();
    } else if (followViewportCommitRef.current == null) {
      followViewportCommitRef.current = setTimeout(
        commit,
        FOLLOW_VIEWPORT_COMMIT_MS - elapsed,
      );
    }
  }, [
    followedUserId, followedPlayer, followedCursor, followedView, viewportSize,
    liveApplyViewport, stopFollowing, setToast,
  ]);

  // Awareness motion reaches this listener before the React presence update.
  // Apply the newest target viewport center/zoom directly on the next paint so
  // a busy board cannot make Follow wait for a full component render. Cursor
  // is only a compatibility fallback for clients that have not refreshed yet.
  useEffect(() => {
    if (!followedUserId) return undefined;
    const applyLatest = () => {
      followMotionFrameRef.current = null;
      const player = followMotionPlayerRef.current;
      followMotionPlayerRef.current = null;
      if (!followedUserIdRef.current || !player) return;
      const hasViewCenter = Number.isFinite(player.view?.x) && Number.isFinite(player.view?.y);
      const targetPoint = hasViewCenter ? player.view : player.cursor;
      if (!targetPoint) return;
      if (!hasViewCenter
        && Date.now() - Number(player.cursor?.updatedAt || 0) >= PLAYER_CURSOR_STALE_MS) return;
      const next = centerViewportOnWorld(
        {
          ...viewportRef.current,
          zoom: player.view?.zoom || viewportRef.current.zoom,
        },
        viewportSize,
        targetPoint,
      );
      liveApplyViewport(next, { broadcastView: false });
    };
    const onPresenceChange = (event) => {
      const targetId = followedUserIdRef.current;
      const player = targetId ? event?.detail?.[targetId] : null;
      const hasViewCenter = Number.isFinite(player?.view?.x) && Number.isFinite(player?.view?.y);
      if (!hasViewCenter && !player?.cursor) return;
      const signature = hasViewCenter
        ? `${targetId}:view:${player.view.updatedAt || 0}`
        : `${targetId}:cursor:${player.cursor.updatedAt || 0}`;
      if (signature === followMotionSignatureRef.current) return;
      followMotionSignatureRef.current = signature;
      followMotionPlayerRef.current = player;
      if (followMotionFrameRef.current == null) {
        followMotionFrameRef.current = requestAnimationFrame(applyLatest);
      }
    };
    const unsubscribe = storage.onPresenceChange(onPresenceChange);
    onPresenceChange({ detail: storage.getPresenceSnapshot() });
    return () => {
      unsubscribe?.();
      followMotionPlayerRef.current = null;
      if (followMotionFrameRef.current != null) {
        cancelAnimationFrame(followMotionFrameRef.current);
        followMotionFrameRef.current = null;
      }
    };
  }, [followedUserId, viewportSize, liveApplyViewport]);

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
    stopFollowing();
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
      pinch: e.ctrlKey || e.metaKey,
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
          const factor = wheelZoomFactor(ev.deltaY, ev.pinch);
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
  }, [cancelPendingWheel, liveApplyViewport, stopFollowing]);

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
    stopFollowing();
    if (!spaceHeldRef.current && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    startPan(e);
  }, [startPan, stopFollowing]);

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
    stopFollowing();
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(fitViewportToItems(boardRef.current.items, rect.width, rect.height));
  }, [commitViewportImmediately, stopFollowing]);

  const fitToSelection = useCallback(() => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    stopFollowing();
    const ids = selectedIdsRef.current;
    if (ids.size === 0) return;
    const items = boardRef.current.items.filter((it) => ids.has(it.id));
    if (items.length === 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(fitViewportToItems(items, rect.width, rect.height));
  }, [commitViewportImmediately, stopFollowing]);

  const zoomBy = useCallback((factor) => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    stopFollowing();
    const rect = canvasRef.current.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    const current = viewportRef.current;
    commitViewportImmediately(zoomViewportAt(current, current.zoom * factor, center));
  }, [commitViewportImmediately, stopFollowing]);

  const resetZoom = useCallback(() => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    stopFollowing();
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(zoomViewportAt(viewportRef.current, 1, {
      x: rect.width / 2,
      y: rect.height / 2,
    }));
  }, [commitViewportImmediately, stopFollowing]);

  const startMinimapNavigation = useCallback((e) => {
    if (e.button !== 0 || interactionRef.current !== null || !minimapModelRef.current) return;
    stopFollowing();
    e.preventDefault();
    e.stopPropagation();
    settleWheelBeforeInteraction();
    const surface = e.currentTarget;
    const surfaceRect = surface.getBoundingClientRect();
    const pointerId = e.pointerId;
    const startZoom = viewportRef.current.zoom;
    let pendingPoint = null;
    let frame = null;
    let finished = false;

    const navigate = (clientX, clientY) => {
      const model = minimapModelRef.current;
      if (!model) return;
      const worldPoint = minimapPointToWorld({ clientX, clientY }, surfaceRect, model);
      liveApplyViewport(centerViewportOnWorld(
        { ...viewportRef.current, zoom: startZoom },
        model.viewportSize,
        worldPoint,
      ));
    };
    const flush = () => {
      frame = null;
      if (!pendingPoint) return;
      const point = pendingPoint;
      pendingPoint = null;
      navigate(point.x, point.y);
    };
    const queue = (clientX, clientY) => {
      pendingPoint = { x: clientX, y: clientY };
      if (frame == null) frame = requestAnimationFrame(flush);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      queue(ev.clientX, ev.clientY);
    };
    const removeListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (frame != null) { cancelAnimationFrame(frame); frame = null; }
      if (pendingPoint) {
        const point = pendingPoint;
        pendingPoint = null;
        navigate(point.x, point.y);
      }
      interactionRef.current = null;
      surface.style.cursor = 'crosshair';
      removeListeners();
      if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
      setViewport(viewportRef.current);
    };
    const onUp = (ev) => { if (ev.pointerId === pointerId) finalize(); };
    const onCancel = (ev) => { if (ev.pointerId === pointerId) finalize(); };
    const onBlur = () => finalize();

    interactionRef.current = { kind: 'minimap' };
    surface.style.cursor = 'grabbing';
    navigate(e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    activeViewportFinalizerRef.current = onBlur;
  }, [liveApplyViewport, settleWheelBeforeInteraction, stopFollowing]);

  const onMinimapKeyDown = useCallback((e) => {
    const model = minimapModelRef.current;
    if (!model || interactionRef.current !== null) return;
    const current = viewportRef.current;
    const stepX = model.viewportSize.w * 0.2;
    const stepY = model.viewportSize.h * 0.2;
    let next = null;
    if (e.key === 'ArrowLeft') next = { ...current, x: current.x + stepX };
    if (e.key === 'ArrowRight') next = { ...current, x: current.x - stepX };
    if (e.key === 'ArrowUp') next = { ...current, y: current.y + stepY };
    if (e.key === 'ArrowDown') next = { ...current, y: current.y - stepY };
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    commitViewportImmediately(next);
  }, [commitViewportImmediately]);

  const updateZIndexes = useCallback((entries) => {
    if (!storage.updateItems(entries)) { reportWriteFailure(); return false; }
    const byId = new Map(entries.map((entry) => [entry.id, entry.patch.zIndex]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (
        byId.has(it.id) ? { ...it, zIndex: byId.get(it.id) } : it
      )),
    }));
    return true;
  }, [reportWriteFailure]);

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
      const isHidden = isStickyHiddenForUser(it, b.items, b.allRevealed, userId);
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
      if (commentsOpenReadable) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setCommentsOpenFor(null);
        }
        return;
      }
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(
        'input, textarea, select, [contenteditable="true"], '
        + '[role="dialog"], [data-board-shortcuts="off"]',
      )) return;
      if (e.key === 'Escape' && followedUserIdRef.current) {
        e.preventDefault();
        stopFollowing();
        return;
      }
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
    nameModalOpen, commentsOpenReadable, selectedIds, deleteItemsIfAllowed, duplicateItems, doUndo, doRedo,
    fitToContent, fitToSelection, zoomBy, resetZoom,
    bringToFront, sendToBack, bringForward, sendBackward,
    stopFollowing,
  ]);

  /* ============================================================
     Image import (paste + drop)
     ============================================================ */
  useEffect(() => {
    const onPaste = async (e) => {
      if (commentsOpenReadable) return;
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
  }, [commentsOpenReadable, importImageFromBlob, screenToWorld, requireEdit]);

  const onCanvasDragOver = useCallback((e) => {
    allowCanvasFileDrop(e);
    const point = dragClientPoint(e);
    if (point && (point.x !== 0 || point.y !== 0)) fileDragPointRef.current = point;
  }, []);

  const onCanvasDrop = useCallback(async (e) => {
    const imageBlobs = droppedImageBlobs(e.dataTransfer);
    if (!imageBlobs.length) return;
    e.preventDefault();
    if (!requireEdit()) return;
    const clientPoint = resolveDropClientPoint(e, fileDragPointRef.current);
    fileDragPointRef.current = null;
    if (!clientPoint) return;
    const w = clientPointToWorld(
      clientPoint.x,
      clientPoint.y,
      worldMeasureRef.current,
    );
    if (!w) return;
    for (const blob of imageBlobs) {
      // eslint-disable-next-line no-await-in-loop
      await importImageFromBlob(blob, w.x, w.y);
    }
  }, [importImageFromBlob, requireEdit]);

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
     Live editing: focus the field and merge every keystroke through Y.Text.
     ============================================================ */
  const canEditItem = useCallback((it) => {
    return !!it && editingAllowed;
  }, [editingAllowed]);

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

  const onTextChange = useCallback((id, patch, opts) => {
    const boundedPatch = { ...patch };
    if (typeof boundedPatch.text === 'string') {
      boundedPatch.text = boundedPatch.text.slice(0, BOARD_TEXT_MAX_LENGTH);
    }
    if (typeof boundedPatch.title === 'string') {
      boundedPatch.title = boundedPatch.title.slice(0, ZONE_TITLE_MAX_LENGTH);
    }
    updateItem(id, boundedPatch, opts);
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
    try {
      if (window.storage.startVoteSession(zoneId, timerPatch, staleResultZoneIds, capturedIds) !== true) {
        reportWriteFailure();
        return;
      }
    } catch {
      reportWriteFailure();
      return;
    }
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
  }, [isAdmin, t, reportWriteFailure]);

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
    window.storage?.clearAllComments?.();
    // Full replace: drop every item, reset session meta, preserve admin identity.
    if (!replaceBoardLocal({
      ...boardRef.current,
      items: [],
      timer: null,
      lastResultsAt: null,
      allRevealed: false,
      votingLocked: false,
      editingLocked: false,
    })) return;
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
      if (!storage.updateItems(zoneEntries)) { reportWriteFailure(); return; }
      const patchById = new Map(zoneEntries.map((entry) => [entry.id, entry.patch]));
      setBoard((prev) => ({
        ...prev,
        items: prev.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        )),
      }));
    }
    patchMeta({ lastResultsAt: null });
    setConfirmResetVotes(false);
    setToast({ msg: t('reset.done'), type: 'info' });
  }, [isAdmin, patchMeta, reportWriteFailure]);

  // Clears every protective flag on the board in one go: per-zone locks,
  // per-sticky privacy, and the board-wide edit lock. A durable reset (not a
  // display-only override like "reveal all cards") so the objects stay
  // unlocked/public after a reload, not just for the current view.
  const adminUnlockAll = useCallback(() => {
    if (!isAdmin) return;
    const entries = boardRef.current.items
      .filter((i) => (i.type === 'zone' && i.locked) || (i.type === 'sticky' && i.private))
      .map((i) => ({ id: i.id, patch: i.type === 'zone' ? { locked: false } : { private: false } }));
    if (entries.length) {
      if (!storage.updateItems(entries)) { reportWriteFailure(); return; }
      const patchById = new Map(entries.map((entry) => [entry.id, entry.patch]));
      setBoard((prev) => ({
        ...prev,
        items: prev.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        )),
      }));
    }
    patchMeta({ editingLocked: false });
    setConfirmUnlockAll(false);
    setToast({ msg: t('unlockAll.done'), type: 'info' });
  }, [isAdmin, patchMeta, reportWriteFailure]);

  /* ----- Export / Import ----- */
  const [exportBusy, setExportBusy] = useState(false);
  const exportBoard = useCallback(async () => {
    if (exportBusy) return;
    setExportBusy(true);
    setToast({ msg: t('export.processing'), type: 'info' });
    const b = boardRef.current;
    const voteSnap = window.storage?.snapshotVotes?.() || new Map();
    const votes = Object.create(null);
    voteSnap.forEach((set, itemId) => { votes[itemId] = Array.from(set); });
    const commentSnap = window.storage?.snapshotComments?.() || new Map();
    const comments = Object.create(null);
    commentSnap.forEach((entries, itemId) => { comments[itemId] = entries; });
    const redacted = redactBoardExportForViewer(
      b.items,
      comments,
      (sticky) => isStickyHiddenForUser(sticky, b.items, b.allRevealed, userId),
    );
    let artifact;
    try {
      artifact = await (await loadBoardArchive()).createBoardArchiveArtifact({
        fallbackBoardCode: boardCode,
        board: {
          items: redacted.items,
          timer: b.timer,
          editingLocked: b.editingLocked,
          votingLocked: b.votingLocked,
          allRevealed: b.allRevealed,
          lastResultsAt: b.lastResultsAt,
        },
        votes,
        comments: redacted.comments,
        customTemplates,
      }, readBackupImage);
    } catch (err) {
      setExportBusy(false);
      setToast({ msg: t('export.fail', { err: err.message }), type: 'warn' });
      return;
    }
    setExportBusy(false);
    const blob = artifact.blob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.fileName;
    a.click();
    // Some browsers (Firefox/Safari) start the download asynchronously after
    // `a.click()` returns. Revoking on the same tick can leave the request
    // pointing at a freed blob → empty file. Defer past the current task so
    // the download has time to grab the blob first.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    const { positions, zoneDimensions } = artifact.geometryRepairs;
    setToast({
      msg: positions || zoneDimensions
        ? t('export.repaired', { file: artifact.fileName, positions, zones: zoneDimensions })
        : t('export.done', { file: artifact.fileName }),
      type: 'info',
    });
  }, [boardCode, customTemplates, userId, exportBusy]);

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
      const hide = isStickyHiddenForUser(sticky, b.items, b.allRevealed, userId);
      lines.push([
        hide ? t('export.csv.hidden') : (sticky.text || ''),
        sticky.authorName || '',
        voteSnap.get(sticky.id)?.size ?? 0,
        csvColorName(sticky.color ?? 0),
        sticky.createdAt ? new Date(sticky.createdAt).toISOString() : '',
      ].map(csvEsc).join(','));
    });
    const csv = '﻿' + lines.join('\r\n'); // UTF-8 BOM for Excel
    const artifact = createCsvExportArtifact({
      csv,
      fallbackBoardCode: boardCode,
      zoneTitle: zone.title,
    });
    const blob = new Blob([artifact.contents], { type: artifact.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setToast({ msg: t('export.done', { file: artifact.fileName }), type: 'info' });
  }, [boardCode, userId]);

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
      const hide = isStickyHiddenForUser(sticky, b.items, b.allRevealed, userId);
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
    const artifact = createCsvExportArtifact({ csv, fallbackBoardCode: boardCode });
    const blob = new Blob([artifact.contents], { type: artifact.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setToast({ msg: t('export.done', { file: artifact.fileName }), type: 'info' });
  }, [boardCode, userId]);

  const fileInputRef = useRef(null);
  const [pendingImport, setPendingImport] = useState(null); // normalized manifest awaiting confirmation
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
      const isCsv = file.name.toLowerCase().endsWith('.csv') || /text\/csv/i.test(file.type);
      const isArchive = file.name.toLowerCase().endsWith('.zip') || /application\/zip/i.test(file.type);
      const maxFileBytes = isArchive ? IMPORT_MAX_ARCHIVE_FILE_BYTES
        : isCsv ? IMPORT_MAX_CSV_FILE_BYTES : IMPORT_MAX_FILE_BYTES;
      if (file.size > maxFileBytes) {
        throw new Error(`file exceeds ${(maxFileBytes / 1024 / 1024).toFixed(0)} MB`);
      }
      const importedAt = Date.now();
      const text = isArchive ? null : await file.text();
      const csvImport = isCsv ? parseBoardCsv(text, importedAt) : null;
      const manifest = isArchive ? await (await loadBoardArchive()).readBoardArchive(file, importedAt)
        : normalizeImportManifest(csvImport ? csvImport.payload : JSON.parse(text), importedAt);
      setPendingImport({
        name: file.name,
        ...manifest,
        sourceFormat: isArchive ? 'zip' : isCsv ? 'csv' : 'json',
        csvSummary: csvImport?.summary ?? null,
      });
    } catch (err) {
      setToast({ msg: t('import.fail', { err: err.message }), type: 'warn' });
    }
  }, []);

  const confirmImport = useCallback(async () => {
    if (!pendingImport || !isAdmin || importBusy) return;
    const {
      items, voteEntries, commentEntries, customTemplates: importedTemplates, boardMeta,
    } = pendingImport;
    const rawItems = items.map((item) => (
      item.type === 'zone'
        ? { ...item, voteTimer: null, lastResultsAt: null, votingLocked: false }
        : item
    ));
    setImportBusy(true);
    let importedItems;
    try {
      importedItems = await sanitizeImportedImages(rawItems, pendingImport.readImageBlob);
    } catch (err) {
      setImportBusy(false);
      setToast({ msg: t('import.fail', { err: err.message }), type: 'warn' });
      return;
    }
    const nextBoard = {
      ...DEFAULT_BOARD,
      items: importedItems,
      timer: boardMeta.timer,
      editingLocked: boardMeta.editingLocked,
      votingLocked: boardMeta.votingLocked,
      allRevealed: boardMeta.allRevealed,
      lastResultsAt: boardMeta.lastResultsAt,
      // Preserve identity-of-the-room across import: who's admin, what their
      // display name is, and the PIN gate. Otherwise an admin importing a
      // backup would silently wipe their own PIN and re-prompt to set a new
      // one on the next destructive action.
      adminUserId: boardRef.current.adminUserId,
      adminName: boardRef.current.adminName,
      adminPinHash: boardRef.current.adminPinHash,
    };
    const snapshotBytes = importBundleByteLength({
      board: nextBoard,
      votes: voteEntries,
      comments: commentEntries,
      customTemplates: importedTemplates,
    });
    if (snapshotBytes > IMPORT_MAX_BUNDLE_BYTES) {
      setImportBusy(false);
      setToast({
        msg: t('import.tooLarge', { mb: (IMPORT_MAX_BUNDLE_BYTES / 1024 / 1024).toFixed(1) }),
        type: 'warn',
      });
      return;
    }
    const imported = window.storage?.importBundle?.(
      nextBoard, voteEntries, commentEntries, importedTemplates,
    );
    if (!imported) {
      setImportBusy(false);
      setToast({ msg: t('import.fail', { err: 'invalid import bundle' }), type: 'warn' });
      return;
    }
    setBoard(nextBoard);
    if (Array.isArray(importedTemplates)) setCustomTemplates(importedTemplates);
    const n = importedItems.length;
    setPendingImport(null);
    setImportBusy(false);
    setToast({
      msg: t('import.done', { n }),
      type: 'info',
    });
  }, [pendingImport, isAdmin, importBusy]);

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
      selected={selectedIds.has(it.id) && !remoteSelectorsByItem.has(it.id)}
      remoteSelected={remoteSelectorsByItem.has(it.id)}
      remoteSelectionHue={hueFromId(remoteSelectorsByItem.get(it.id)?.userId || '')}
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
      selected={selectedIds.has(it.id) && !remoteSelectorsByItem.has(it.id)}
      remoteSelected={remoteSelectorsByItem.has(it.id)}
      remoteSelectionHue={hueFromId(remoteSelectorsByItem.get(it.id)?.userId || '')}
      isEditing={focusedTextId === `${it.id}:text`}
      isOwner={it.authorId === userId}
      allRevealed={stickyVotingContext.get(it.id)?.revealed ?? board.allRevealed}
      dense={denseRender}
      compact={compactRender}
      voted={didUserVoteOn(it.id)}
      voteCount={voteCountOf(it.id)}
      voteFlash={voteFlashes[it.id] || null}
      voteRank={topVotedRanks.get(it.id)}
      votingAllowedNow={stickyVotingContext.get(it.id)?.votingAllowedNow ?? false}
      showVoteCount={!(stickyVotingContext.get(it.id)?.hideVoteCounts ?? false)}
      inZone={stickyVotingContext.get(it.id)?.inZone ?? false}
      commentCount={commentCountOf(it.id)}
      commentPreviews={commentPreviewsByItem.get(it.id) ?? EMPTY_COMMENT_PREVIEWS}
      lang={lang}
      onStartDrag={startItemDrag}
      onBeginFocus={beginFocus}
      onTextChange={onTextChange}
      onTextKeyDown={onTextKeyDown}
      onTextBlur={onTextBlur}
      onToggleVote={toggleVote}
      onOpenComments={openComments}
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
      selected={selectedIds.has(it.id) && !remoteSelectorsByItem.has(it.id)}
      remoteSelected={remoteSelectorsByItem.has(it.id)}
      remoteSelectionHue={hueFromId(remoteSelectorsByItem.get(it.id)?.userId || '')}
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
      remoteSelectorsByItem,
      focusedTextId,
      votesByItem,
      commentsByItem,
      commentPreviewsByItem,
      voteFlashes,
      topVotedRanks,
      stickyVotingContext,
      userId,
      denseRender,
      compactRender,
      lang,
      zoneChildCount,
      startItemDrag,
      startZoneDrag,
      beginFocus,
      onTextChange,
      onTextKeyDown,
      onTextBlur,
      toggleVote,
      openComments,
    ],
  );

  const renderActionToolbar = () => {
    if (focusedTextId) return null;
    const v = viewportRef.current;
    if (groupBBox && selectedIds.size > 1) {
      const lockedCount = board.items.reduce((count, item) => (
        selectedIds.has(item.id) && item.locked ? count + 1 : count
      ), 0);
      const canUnlock = editingAllowed && lockedCount > 0;
      const sx = (groupBBox.x + groupBBox.w / 2) * v.zoom + v.x;
      const sy = toolbarAnchorY(groupBBox.y * v.zoom + v.y - SELECTION_TOOLBAR_GAP_PX);
      return (
        <div
          style={{
            position: 'fixed', left: sx, top: sy,
            transform: 'translate(-50%, -100%)',
            background: 'var(--bg-panel)', borderRadius: 10,
            boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
            padding: '6px 8px', display: 'flex', alignItems: 'center',
            zIndex: Z.SELECTION_TOOLBAR, pointerEvents: 'auto', animation: 'rb-pop 0.18s ease-out',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={unlockSelectedItems}
            disabled={!canUnlock}
            title={lockedCount > 0
              ? t('selection.unlockAll', { n: lockedCount })
              : t('selection.nothingLocked')}
            style={{ ...iconBtn(canUnlock), gap: 5, padding: '5px 8px' }}
          >
            <Unlock size={15} />
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {t('selection.unlockAll', { n: lockedCount })}
            </span>
          </button>
        </div>
      );
    }
    if (!selectedItem) return null;
    let sx;
    let sy;
    if (selectedItem.type === 'zone') {
      sx = selectedItem.x * v.zoom + v.x + (selectedItem.w * v.zoom) / 2;
      sy = selectedItem.y * v.zoom + v.y - ZONE_TITLE_H * v.zoom - SELECTION_TOOLBAR_GAP_PX;
    } else if (selectedItem.type === 'sticky' || selectedItem.type === 'image') {
      const iw = selectedItem.w || (selectedItem.type === 'sticky' ? STICKY_W : 200);
      sx = selectedItem.x * v.zoom + v.x + (iw * v.zoom) / 2;
      sy = selectedItem.y * v.zoom + v.y - SELECTION_TOOLBAR_GAP_PX;
    } else {
      sx = selectedItem.x * v.zoom + v.x + 60;
      sy = selectedItem.y * v.zoom + v.y - SELECTION_TOOLBAR_GAP_PX;
    }
    // The toolbar is translated upward by its own height. Keep its bottom
    // anchor far enough below the 60px top bar that admin controls cannot sit
    // above it and intercept clicks (most visible on fitted/zoomed-out zones).
    sy = toolbarAnchorY(sy);
    const can = canModifyOwnedItem(selectedItem);
    const canDelete = canDeleteItem(selectedItem);
    // A zone with no explicit override inherits visibility from its nearest
    // ancestor (or the legacy board-wide value). The eye action must toggle
    // that effective state; toggling the raw undefined value would write true
    // again when an inherited-visible zone is clicked, making "hide" a no-op.
    const selectedZoneRevealed = selectedItem.type === 'zone'
      ? (selectedItem.revealed ?? effectiveRevealed(selectedItem, board.items, board.allRevealed))
      : false;
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
          zIndex: Z.SELECTION_TOOLBAR,
          pointerEvents: 'auto',
          animation: 'rb-pop 0.18s ease-out',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(selectedItem.type === 'sticky' || selectedItem.type === 'zone') && (
          <div style={{ display: 'flex', gap: 4 }}>
            {PALETTE.map((c, i) => (
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
                  style={{ position: 'fixed', inset: 0, zIndex: Z.TOOLBAR_POPOVER_BACKDROP }}
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
                    gap: 6, zIndex: Z.TOOLBAR_POPOVER,
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
            onClick={() => updateItem(selectedItem.id, { revealed: !selectedZoneRevealed })}
            title={selectedZoneRevealed ? t('zone.hideCards') : t('zone.revealCards')}
            aria-label={selectedZoneRevealed ? t('zone.hideCards') : t('zone.revealCards')}
            style={iconBtn(true)}
          >
            {selectedZoneRevealed ? <EyeOff size={15} /> : <Eye size={15} />}
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
              zIndex: Z.SELECTION_OUTLINE,
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
                zIndex: Z.SELECTION_HANDLE,
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
          zIndex: Z.SELECTION_HANDLE,
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
        position: 'fixed', top: TOPBAR_INSET_PX, left: 0, right: 0, height: TOPBAR_H_PX,
        background: 'var(--bg-overlay)', backdropFilter: 'blur(8px)',
        borderBottom: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px',
        zIndex: Z.TOPBAR,
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
          fontWeight: 500, fontSize: 18, fontFamily: 'var(--font-display)',
        }}
      >
        <Sparkles size={18} color="var(--accent)" /> {t('app.title')}
      </button>
      {boardCode && (
        <button
          type="button"
          onClick={async () => {
            // Share URL must include the token in the #fragment so joiners
            // land on the same yjs doc. Without it they'd get a sibling
            // tokenless board with the same code prefix.
            const shareUrl = `${window.location.origin}/b/${boardCode}${boardToken ? `#${boardToken}` : ''}`;
            if (await copyTextToClipboard(navigator.clipboard, shareUrl)) {
              setToast({ msg: t('topbar.copied'), type: 'info' });
            } else {
              const manualCode = `${boardCode}${boardToken ? `#${boardToken}` : ''}`;
              setToast({ msg: t('topbar.shareLink', { code: manualCode }), type: 'info', sticky: true });
            }
          }}
          title={t('topbar.copyLink')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--bg-panel-2)', border: '1px solid #e5e7eb',
            borderRadius: 999, padding: '4px 10px',
            fontFamily: 'var(--font-mono)',
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
          accept="application/zip,.zip,application/json,.json,text/csv,.csv"
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
                style={{ position: 'fixed', inset: 0, zIndex: Z.POPOVER_BACKDROP }}
              />
              <div
                style={{
                  position: 'absolute', top: '110%', right: 0,
                  background: 'var(--bg-elev)', borderRadius: 10,
                  boxShadow: 'var(--shadow-pop)',
                  padding: 6, marginTop: 6, minWidth: 220, zIndex: Z.POPOVER,
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
                  label={exportBusy ? t('export.processing') : t('topbar.export')}
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
                  icon={<Unlock size={15} />}
                  label={t('topbar.unlockAll')}
                  disabled={!isAdmin}
                  onClick={() => {
                    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
                    setMoreMenuOpen(false);
                    setConfirmUnlockAll(true);
                  }}
                />
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
                style={{ position: 'fixed', inset: 0, zIndex: Z.POPOVER_BACKDROP }}
              />
              <div
                data-board-shortcuts="off"
                style={{
                  position: 'absolute', top: '110%', right: 0,
                  background: 'var(--bg-panel)', borderRadius: 10,
                  boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
                  padding: 8, marginTop: 6, minWidth: 200, zIndex: Z.POPOVER,
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
            background: 'var(--accent)', color: 'var(--accent-fg)',
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
              style={{ position: 'fixed', inset: 0, zIndex: Z.POPOVER_BACKDROP }}
            />
            <div
              style={{
                position: 'absolute', top: '110%', right: 0,
                background: 'var(--bg-elev)', borderRadius: 10,
                boxShadow: 'var(--shadow-pop)',
                padding: 8, marginTop: 6, minWidth: 300, zIndex: Z.POPOVER,
                animation: 'rb-pop 0.18s ease-out',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}>
                {t('players.head', { n: onlineUsers.length })}
              </div>
              {onlineUsers.map((u) => {
                const isMe = u.userId === userId;
                const isUserAdmin = u.userId === board.adminUserId;
                const isFollowing = u.userId === followedUserId;
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
                      background: isFollowing ? 'var(--accent-bg)' : 'transparent',
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
                        color: isFull ? 'var(--ok-text)' : 'var(--text-muted)',
                        background: isFull ? 'var(--ok-bg)' : 'var(--bg-panel-2)',
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
                    {!isMe && (
                      <button
                        type="button"
                        aria-pressed={isFollowing}
                        title={isFollowing ? t('follow.stop') : t('follow.start', { name: u.name })}
                        onClick={() => {
                          if (isFollowing) {
                            stopFollowing();
                            setPlayerListOpen(false);
                          } else {
                            startFollowing(u.userId);
                          }
                        }}
                        style={{
                          width: 30, height: 30, display: 'grid', placeItems: 'center',
                          flex: '0 0 auto', borderRadius: 8, cursor: 'pointer',
                          border: `1px solid ${isFollowing ? 'var(--accent)' : 'var(--border)'}`,
                          background: isFollowing ? 'var(--accent)' : 'var(--bg-panel)',
                          color: isFollowing ? 'var(--accent-fg)' : 'var(--text-mid)',
                        }}
                      >
                        <LocateFixed size={15} />
                      </button>
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
          display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', zIndex: Z.TIMER_DOCK,
        }}
      >
        {activeZones.map((z) => renderTimerDockFor(z))}
      </div>
    );
  };

  const renderMinimap = () => {
    return (
      <aside
        ref={minimapPanelRef}
        className="rb-minimap"
        aria-label={t('minimap.title')}
        onPointerEnter={revealMinimap}
        onPointerLeave={revealMinimap}
        onFocusCapture={revealMinimap}
        onBlurCapture={revealMinimap}
        style={{
          position: 'fixed', right: 16, bottom: 60, zIndex: Z.DOCK,
          width: MINIMAP_W + 16,
          padding: '8px 8px 9px', boxSizing: 'border-box',
          background: 'var(--bg-overlay)',
          border: '1px solid var(--border-soft)', borderRadius: 14,
          boxShadow: '0 12px 30px rgba(0,0,0,0.14)',
          backdropFilter: 'blur(12px)',
          opacity: 0, pointerEvents: 'none',
          transition: 'opacity 220ms ease',
        }}
      >
        <div style={{
          height: 25, display: 'flex', alignItems: 'center', gap: 7,
          padding: '0 3px 6px', color: 'var(--text-mid)',
        }}
        >
          <MapIcon size={15} aria-hidden="true" />
          <span style={{ fontSize: 14, lineHeight: 1, fontWeight: 700, flex: 1 }}>
            {t('minimap.title')}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(viewport.zoom * 100)}%
          </span>
        </div>
        <div
          className="rb-minimap-surface"
          role="button"
          tabIndex={0}
          aria-label={t('minimap.navigate')}
          title={t('minimap.navigate')}
          onPointerDown={startMinimapNavigation}
          onKeyDown={onMinimapKeyDown}
          style={{
            position: 'relative', width: MINIMAP_W, height: MINIMAP_H,
            overflow: 'hidden', cursor: 'crosshair', touchAction: 'none',
            border: '1px solid var(--border)', borderRadius: 9,
            backgroundColor: 'var(--bg)',
            backgroundImage: 'radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)',
            backgroundSize: '10px 10px', boxSizing: 'border-box',
            outline: 'none',
          }}
        >
          <MinimapCanvas model={minimapModel} colors={PALETTE} />
          <div
            ref={minimapViewportRef}
            aria-hidden="true"
            style={{
              position: 'absolute', left: 0, top: 0,
              width: minimapModel.viewport.w,
              height: minimapModel.viewport.h,
              minWidth: 6, minHeight: 6,
              transform: `translate3d(${minimapModel.viewport.x}px, ${minimapModel.viewport.y}px, 0)`,
              boxSizing: 'border-box', border: '2px solid var(--accent)',
              borderRadius: 4, background: 'rgba(14,165,233,0.13)',
              boxShadow: '0 0 0 1px rgba(255,255,255,0.5) inset',
              pointerEvents: 'none', willChange: 'transform, width, height',
            }}
          />
        </div>
      </aside>
    );
  };

  const renderBottomBar = () => (
    <>
      {/* Templates (bottom-left) */}
      <div style={{ position: 'fixed', bottom: 16, left: 16, zIndex: Z.DOCK }}>
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
                style={{ position: 'fixed', inset: 0, zIndex: Z.POPOVER_BACKDROP }}
              />
              <div
                data-board-shortcuts="off"
                style={{
                  position: 'absolute', bottom: '120%', left: 0,
                  background: 'var(--bg-panel)', borderRadius: 12, padding: 8,
                  boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
                  minWidth: 300, maxHeight: '70vh', overflow: 'auto', zIndex: Z.POPOVER,
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
        position: 'fixed', bottom: 16, left: 170, zIndex: Z.DOCK,
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
            color: creationMode === 'select' ? 'var(--accent-fg)' : 'var(--text)',
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
            color: creationMode === 'zone' ? 'var(--accent-fg)' : 'var(--text)',
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

      {renderMinimap()}

      {/* Zoom (bottom-right) */}
      <div
        style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: Z.DOCK,
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
        fontFamily: 'var(--font-ui)',
      }}
      >{t('loading') || 'Loading…'}
      </div>
    );
  }

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', fontFamily: 'var(--font-ui)' }}
    >
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
        @keyframes rb-editing-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        @keyframes rb-selection-aura {
          0%, 100% {
            box-shadow:
              0 0 0 2px hsl(var(--rb-selector-hue) 78% 52% / 0.72),
              0 0 12px 3px hsl(var(--rb-selector-hue) 82% 55% / 0.42),
              0 0 24px 7px hsl(var(--rb-selector-hue) 86% 60% / 0.18);
          }
          50% {
            box-shadow:
              0 0 0 3px hsl(var(--rb-selector-hue) 82% 50% / 0.90),
              0 0 20px 6px hsl(var(--rb-selector-hue) 86% 55% / 0.58),
              0 0 34px 12px hsl(var(--rb-selector-hue) 90% 62% / 0.28);
          }
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
        @keyframes rb-comment-slide {
          0%   { opacity: 0; transform: translateX(10px); }
          18%  { opacity: 1; transform: translateX(0); }
          82%  { opacity: 1; transform: translateX(0); }
          100% { opacity: 0; transform: translateX(-10px); }
        }
        .rb-comment-slide {
          animation: rb-comment-slide ${COMMENT_CAROUSEL_MS}ms ease-in-out both;
        }
        .rb-editing-dot {
          animation: rb-editing-pulse 1.1s ease-in-out infinite;
        }
        .rb-remote-selected-card {
          --rb-selector-hue: 200;
          box-shadow:
            0 0 0 2px hsl(var(--rb-selector-hue) 78% 52% / 0.72),
            0 0 12px 3px hsl(var(--rb-selector-hue) 82% 55% / 0.42),
            0 0 24px 7px hsl(var(--rb-selector-hue) 86% 60% / 0.18);
          animation: rb-selection-aura 1.8s ease-in-out infinite;
        }
        .rb-minimap-surface:focus-visible {
          outline: 3px solid var(--accent) !important;
          outline-offset: 2px;
        }
        @media (max-width: 700px) {
          .rb-minimap {
            transform: scale(0.82);
            transform-origin: bottom right;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .rb-comment-slide { animation: none !important; }
          .rb-minimap { transition: none !important; }
          .rb-player-cursor { transition: none !important; }
          .rb-editing-dot { animation: none !important; }
          .rb-remote-selected-card { animation: none !important; }
        }
        .rb-no-select * { user-select: none; }
      `}</style>

      {/* Grid background (screen-space, behind everything). backgroundSize
          and backgroundPosition are applied imperatively (see
          applyViewportToDom) so pan/zoom don't go through React. */}
      <div
        ref={gridRef}
        style={{
          position: 'absolute', inset: 0, zIndex: Z.GRID,
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
        onPointerMove={onCanvasPointerActivity}
        onPointerLeave={clearLocalCursor}
        onPointerCancel={clearLocalCursor}
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
        className="rb-no-select"
        style={{
          position: 'absolute', inset: 0, zIndex: Z.CANVAS,
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
          {/* A fixed-size, invisible world-space ruler. Its rendered rect lets
              external file drops invert the browser's fully-composed transform
              without guessing how CSS/browser zoom affected the canvas. */}
          <div
            ref={worldMeasureRef}
            aria-hidden="true"
            style={{
              position: 'absolute', left: 0, top: 0,
              width: 100, height: 100,
              opacity: 0, pointerEvents: 'none',
            }}
          />
          {renderedItems}

          {/* Remote card selection label. The glow itself is applied directly
              to each selected card instead of drawing a second card-sized
              layer over it. */}
          {selectionIndicators.map(({ item, selector }) => {
            const zoom = Math.max(viewport.zoom, 0.01);
            const selectorHue = hueFromId(selector.userId);
            const color = `hsl(${selectorHue} 72% 46%)`;
            const label = selector.extraCount > 0
              ? t('selection.byMany', { name: selector.name, n: selector.extraCount })
              : t('selection.by', { name: selector.name });
            return (
              <React.Fragment key={`selection:${item.id}`}>
                <div
                  role="status"
                  aria-label={label}
                  style={{
                    position: 'absolute', left: item.x,
                    top: item.y - (34 / zoom),
                    transform: `scale(${1 / zoom})`, transformOrigin: 'top left',
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    maxWidth: 240, padding: '5px 9px 5px 7px',
                    borderRadius: 999, background: color, color: '#ffffff',
                    boxShadow: '0 3px 10px rgba(0,0,0,0.22)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 13, lineHeight: 1.2, fontWeight: 700,
                    whiteSpace: 'nowrap', pointerEvents: 'none',
                    zIndex: Z.REMOTE_SELECTION_LABEL,
                  }}
                >
                  <MousePointer2 size={13} style={{ flex: '0 0 auto' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                </div>
              </React.Fragment>
            );
          })}

          {/* Collaboration editing presence. Kept outside each card so the
              badge is never clipped by card paint-containment, and counter-
              scaled so names stay readable at every board zoom level. */}
          {editingIndicators.map(({ item, editor }) => {
            const zoom = Math.max(viewport.zoom, 0.01);
            const width = item.w || (item.type === 'sticky' ? STICKY_W : item.type === 'text' ? TEXT_W : 200);
            const height = item.h || (item.type === 'sticky' ? STICKY_H : item.type === 'text' ? TEXT_H : 200);
            const titleHeight = item.type === 'zone'
              ? Math.max(ZONE_TITLE_H, (item.fontSize || 16) + 18)
              : 0;
            const boxTop = item.y - titleHeight;
            const boxHeight = height + titleHeight;
            const editorHue = hueFromId(editor.userId);
            const color = `hsl(${editorHue} 72% 46%)`;
            const glow = `hsl(${editorHue} 72% 46% / 0.18)`;
            const label = editor.extraCount > 0
              ? t('editing.byMany', { name: editor.name, n: editor.extraCount })
              : t('editing.by', { name: editor.name });
            return (
              <React.Fragment key={`editing:${item.id}`}>
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute', left: item.x, top: boxTop,
                    width, height: boxHeight, boxSizing: 'border-box',
                    border: `${2 / zoom}px solid ${color}`,
                    borderRadius: `${7 / zoom}px`,
                    boxShadow: `0 0 0 ${3 / zoom}px ${glow}`,
                    pointerEvents: 'none', zIndex: Z.REMOTE_EDITOR_BOX,
                  }}
                />
                <div
                  role="status"
                  aria-label={label}
                  style={{
                    position: 'absolute', left: item.x,
                    top: boxTop + boxHeight + (8 / zoom),
                    transform: `scale(${1 / zoom})`, transformOrigin: 'top left',
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    maxWidth: 240, padding: '5px 9px 5px 7px',
                    borderRadius: 999, background: color, color: '#ffffff',
                    boxShadow: '0 3px 10px rgba(0,0,0,0.24)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 13, lineHeight: 1.2, fontWeight: 700,
                    whiteSpace: 'nowrap', pointerEvents: 'none',
                    zIndex: Z.REMOTE_EDITOR_LABEL,
                  }}
                >
                  <span
                    className="rb-editing-dot"
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: '#ffffff', flex: '0 0 auto',
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                </div>
              </React.Fragment>
            );
          })}

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

      {/* Remote player cursors use world coordinates from Yjs Awareness, then
          map through this client's viewport. The layer is screen-space so the
          pointer and name stay readable at every board zoom level. */}
      <div
        ref={cursorLayerRef}
        aria-hidden="true"
        style={{
          position: 'fixed', inset: 0, zIndex: Z.CURSOR_LAYER,
          overflow: 'hidden', pointerEvents: 'none',
        }}
      >
        {playerCursors.map((player) => {
          const screen = cursorScreenPosition(player.cursor, viewportRef.current);
          const color = `hsl(${hueFromId(player.userId)} 72% 46%)`;
          return (
            <div
              key={player.userId}
              className="rb-player-cursor"
              data-cursor-x={player.cursor.x}
              data-cursor-y={player.cursor.y}
              style={{
                position: 'absolute', left: 0, top: 0,
                transform: `translate3d(${screen.x}px, ${screen.y}px, 0)`,
                transition: 'transform 18ms linear',
                willChange: 'transform',
                display: 'flex', alignItems: 'flex-start',
              }}
            >
              <MousePointer2
                size={23}
                color="#ffffff"
                fill={color}
                strokeWidth={2.6}
                style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.38))', flex: '0 0 auto' }}
              />
              <span
                style={{
                  marginLeft: -2, marginTop: 17,
                  maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  padding: '4px 8px', borderRadius: '4px 9px 9px 9px',
                  background: color, color: '#ffffff',
                  fontSize: 13, lineHeight: 1.15, fontWeight: 700,
                  boxShadow: '0 2px 7px rgba(0,0,0,0.2)',
                }}
              >
                {player.name}
              </span>
            </div>
          );
        })}
      </div>

      {/* Floating UI */}
      {renderTopBar()}
      {followedUserId && (
        <div
          role="status"
          style={{
            position: 'fixed', top: TOPBAR_BOTTOM_PX + FOLLOW_BANNER_GAP_PX, left: '50%', zIndex: Z.FOLLOW_BANNER,
            transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', gap: 9,
            maxWidth: 'calc(100vw - 32px)', padding: '7px 8px 7px 11px',
            background: 'var(--bg-overlay)', color: 'var(--text)',
            border: '1px solid var(--border-strong)', borderRadius: 999,
            boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
            backdropFilter: 'blur(10px)', animation: 'rb-banner-in 0.2s ease-out',
          }}
        >
          <LocateFixed
            size={16}
            color={`hsl(${hueFromId(followedUserId)} 72% 46%)`}
            style={{ flex: '0 0 auto' }}
          />
          <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' }}>
            {t('follow.active', {
              name: followedPlayer?.name || presence[followedUserId]?.name || 'Guest',
            })}
          </span>
          {!followedView && !followedCursor && (
            <span style={{
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 12, color: 'var(--text-muted)',
            }}
            >{t('follow.waiting')}
            </span>
          )}
          <button
            type="button"
            onClick={stopFollowing}
            title={t('follow.stop')}
            aria-label={t('follow.stop')}
            style={{
              width: 28, height: 28, display: 'grid', placeItems: 'center',
              flex: '0 0 auto', border: 'none', borderRadius: '50%',
              background: 'var(--bg-panel-2)', color: 'var(--text-mid)', cursor: 'pointer',
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
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
            zIndex: Z.MARQUEE,
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
            position: 'fixed', inset: 0, zIndex: Z.MODAL,
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
              maxLength={DISPLAY_NAME_MAX_LENGTH}
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
                  background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
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
      {confirmUnlockAll && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: Z.MODAL,
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
              <Unlock size={22} color="var(--accent)" />
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{t('unlockAll.confirm.head')}</div>
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 18 }}>
              {t('unlockAll.confirm.body')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmUnlockAll(false)}
                style={{
                  background: 'var(--bg-panel-2)', color: 'var(--text-mid)', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: 'pointer', fontSize: 14,
                }}
              >{t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => requireAdminPin(adminUnlockAll)}
                style={{
                  background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
                  padding: '8px 16px', borderRadius: 8, fontWeight: 600,
                  cursor: 'pointer', fontSize: 14,
                }}
              >{t('unlockAll.confirm.ok')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmResetVotes && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: Z.MODAL,
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
                  background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
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
            position: 'fixed', inset: 0, zIndex: Z.MODAL,
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
                n: pendingImport.items.length,
                file: pendingImport.name,
              })}
            </div>
            {pendingImport.sourceFormat === 'csv' && (
              <div
                role="note"
                style={{ fontSize: 13, color: 'var(--warn-text)', marginTop: -8, marginBottom: 18 }}
              >{t('import.csv.warning', {
                votes: pendingImport.csvSummary?.voteCountLost ?? 0,
                skipped: pendingImport.csvSummary?.skippedRows ?? 0,
              })}
              </div>
            )}
            {(pendingImport.geometryRepairs?.positions > 0
              || pendingImport.geometryRepairs?.zoneDimensions > 0) && (
              <div
                role="note"
                style={{ fontSize: 13, color: 'var(--warn-text)', marginTop: -8, marginBottom: 18 }}
              >{t('import.geometry.warning', {
                positions: pendingImport.geometryRepairs.positions,
                zones: pendingImport.geometryRepairs.zoneDimensions,
              })}
              </div>
            )}
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
                  background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
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

      {commentsOpenReadable ? (
        <CommentsModal
          item={commentsOpenItem}
          comments={commentsByItem.get(commentsOpenItem.id) ?? EMPTY_COMMENTS}
          editingAllowed={editingAllowed}
          onAdd={(text) => addCommentTo(commentsOpenItem, text)}
          onDelete={(commentId) => deleteCommentFrom(commentsOpenItem.id, commentId)}
          onClose={() => setCommentsOpenFor(null)}
        />
      ) : null}

      {helpOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setHelpOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: Z.MODAL,
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
                      background: PALETTE[s.color].border,
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
            position: 'fixed', inset: 0, zIndex: Z.MODAL,
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
                  background: 'var(--danger)', color: 'var(--danger-fg)', border: 'none',
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
            color: 'var(--toast-text)', padding: '10px 16px', borderRadius: 10,
            fontSize: 14, fontWeight: 500, zIndex: Z.TOAST,
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
                background: 'transparent', border: 'none', color: 'var(--toast-text)',
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

function CommentsModal({ item, comments, editingAllowed, onAdd, onDelete, onClose }) {
  const [draft, setDraft] = useState('');
  const fmtAgo = (ts) => {
    const diff = Date.now() - ts;
    if (diff < 60_000) return t('common.justNow');
    if (diff < 3600_000) return t('common.minutesAgo', { n: Math.floor(diff / 60000) });
    if (diff < 86_400_000) return t('common.hoursAgo', { n: Math.floor(diff / 3_600_000) });
    return t('common.daysAgo', { n: Math.floor(diff / 86_400_000) });
  };
  const submit = () => {
    const text = draft.trim();
    if (!text || !editingAllowed) return;
    if (onAdd(text) !== false) setDraft('');
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="comments-dialog-title"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: Z.MODAL,
        background: 'var(--bg-modal-veil)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-elev)', borderRadius: 14, padding: 24,
          width: '100%', maxWidth: 560, maxHeight: '82vh',
          boxShadow: 'var(--shadow-modal)', animation: 'rb-pop 0.2s ease-out',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <MessageSquare size={22} color="var(--accent)" />
            <div id="comments-dialog-title" style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{t('comments.title')}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            autoFocus={!editingAllowed}
            style={{
              background: 'transparent', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', padding: 4, display: 'inline-flex',
            }}
          ><X size={18} />
          </button>
        </div>
        {item.text && (
          <div style={{
            color: 'var(--text-muted)', fontSize: 13, marginBottom: 12,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
          >{item.text}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 120, overflowY: 'auto', marginBottom: 16 }}>
          {comments.length === 0 ? (
            <div style={{ color: 'var(--text-faint)', fontSize: 14, textAlign: 'center', padding: '32px 0' }}>
              {t('comments.empty')}
            </div>
          ) : comments.map((comment) => (
            <div
              key={comment.id}
              style={{
                padding: '10px 0', borderBottom: '1px solid var(--border-soft)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ color: 'var(--text)', fontSize: 13, fontWeight: 700 }}>
                  {comment.authorName || 'Anon'}
                </span>
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{fmtAgo(comment.createdAt)}</span>
                <div style={{ flex: 1 }} />
                {editingAllowed && (
                  <button
                    type="button"
                    onClick={() => onDelete(comment.id)}
                    title={t('comments.delete')}
                    aria-label={t('comments.delete')}
                    style={{
                      background: 'transparent', border: 'none', color: 'var(--text-faint)',
                      cursor: 'pointer', padding: 3, display: 'inline-flex',
                    }}
                  ><Trash2 size={14} />
                  </button>
                )}
              </div>
              <div style={{ color: 'var(--text-mid)', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {comment.text}
              </div>
            </div>
          ))}
        </div>
        <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 16 }}>
          <textarea
            autoFocus={editingAllowed}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
              if (e.key === 'Escape') onClose();
            }}
            maxLength={COMMENT_MAX_LEN}
            disabled={!editingAllowed}
            placeholder={t('comments.placeholder')}
            style={{
              width: '100%', minHeight: 80, resize: 'vertical', boxSizing: 'border-box',
              padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--bg-panel)', color: 'var(--text)', fontFamily: 'inherit',
              fontSize: 14, outline: 'none',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button
              type="button"
              onClick={submit}
              disabled={!editingAllowed || !draft.trim()}
              style={{
                background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
                padding: '8px 16px', borderRadius: 8, fontWeight: 600, fontSize: 14,
                cursor: (!editingAllowed || !draft.trim()) ? 'not-allowed' : 'pointer',
                opacity: (!editingAllowed || !draft.trim()) ? 0.5 : 1,
              }}
            >{t('comments.send')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
        position: 'fixed', inset: 0, zIndex: Z.MODAL_RAISED,
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
            boxSizing: 'border-box', fontFamily: 'var(--font-mono)',
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
              boxSizing: 'border-box', fontFamily: 'var(--font-mono)',
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
              background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
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
        minWidth: 320, zIndex: Z.POPOVER,
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
          background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
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
        position: 'fixed', inset: 0, zIndex: Z.MODAL,
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
          maxLength={TEMPLATE_NAME_MAX_LENGTH}
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
              color: 'var(--accent-fg)', border: 'none',
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
