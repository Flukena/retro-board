// Tiny pathname router for /b/<code> boards.
// No history API beyond plain navigation — each visit is a full page load.

import { PUBLIC_PATH } from '../../domain/public-wall-contract.js';
import { legalPageForPath } from '../legal/legal-content.js';

const BOARD_PATH = /^\/b\/([A-Za-z0-9_-]{3,32})\/?$/;
// Tokens are 16 alphanumeric chars (Web Crypto generated). The pattern is
// permissive so older links and hand-edits still parse cleanly; junk in the
// fragment just resolves to an unreachable yjs doc name.
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

function readTokenFromHash() {
  if (typeof window === 'undefined') return null;
  const raw = (window.location.hash || '').replace(/^#/, '').trim();
  if (!raw) return null;
  return TOKEN_RE.test(raw) ? raw : null;
}

export function parseRoute() {
  const path = (typeof window !== 'undefined' ? window.location.pathname : '/') || '/';
  if (path === PUBLIC_PATH || path === `${PUBLIC_PATH}/`) return { kind: 'public' };
  const legalPage = legalPageForPath(path);
  if (legalPage) return { kind: 'legal', page: legalPage };
  const m = path.match(BOARD_PATH);
  if (m) return { kind: 'board', code: m[1], token: readTokenFromHash() };
  return { kind: 'landing' };
}

export function generateBoardCode() {
  // 8-char alphanumeric (~62^8 = 218 trillion). URL-safe, easy to share.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i += 1) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

// 16-char URL-safe secret — combined with the board code the full yjs doc
// name has ~62^24 entropy, well beyond brute-force. Uses Web Crypto when
// available so it's not predictable from Math.random's PRNG state.
export function generateBoardToken() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const len = 16;
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    let s = '';
    for (let i = 0; i < len; i += 1) s += alphabet[buf[i] % alphabet.length];
    return s;
  }
  let s = '';
  for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// Build a full share URL. `token` is optional; without it the link is the
// legacy /b/CODE form and resolves to the pre-token doc name.
export function buildBoardUrl(code, token) {
  const base = `${window.location.origin}/b/${code}`;
  return token ? `${base}#${token}` : base;
}

export function gotoBoard(code, token) {
  window.location.href = token ? `/b/${code}#${token}` : `/b/${code}`;
}

export function gotoLanding() {
  window.location.href = '/';
}

const RECENTS_KEY = 'rb_recents';
const BOARD_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const RECENT_NAME_MAX_LENGTH = 120;

const normalizeToken = (value) => (
  typeof value === 'string' && TOKEN_RE.test(value) ? value : null
);

const normalizeRecent = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.code !== 'string' || !BOARD_CODE_RE.test(value.code)) return null;
  const token = value.token == null ? null : normalizeToken(value.token);
  if (value.token != null && !token) return null;
  return {
    code: value.code,
    token,
    name: typeof value.name === 'string'
      ? value.name.trim().slice(0, RECENT_NAME_MAX_LENGTH)
      : '',
    visitedAt: Number.isSafeInteger(value.visitedAt) && value.visitedAt >= 0
      ? value.visitedAt
      : 0,
  };
};

const parseRecentList = (raw) => {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  return parsed.flatMap((value) => {
    const recent = normalizeRecent(value);
    if (!recent) return [];
    const key = `${recent.code}#${recent.token || ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [recent];
  }).slice(0, 10);
};

const readRecentList = () => {
  try { return parseRecentList(localStorage.getItem(RECENTS_KEY)); }
  catch { return []; }
};

export function rememberRecent(code, name, token) {
  if (!BOARD_CODE_RE.test(code || '')) return;
  const normalizedToken = token == null ? null : normalizeToken(token);
  if (token != null && !normalizedToken) return;
  try {
    const list = readRecentList();
    const previous = list.find((r) => (
      r.code === code && r.token === normalizedToken
    ));
    // Match on (code, token) so a legacy tokenless recent stays distinct
    // from a token-gated one with the same code.
    const filtered = list.filter((r) => !(r.code === code && r.token === normalizedToken));
    const nextName = name === undefined
      ? previous?.name || ''
      : String(name ?? '').trim().slice(0, RECENT_NAME_MAX_LENGTH);
    filtered.unshift({
      code,
      token: normalizedToken,
      name: nextName,
      visitedAt: Date.now(),
    });
    localStorage.setItem(RECENTS_KEY, JSON.stringify(filtered.slice(0, 10)));
  } catch {
    /* swallow */
  }
}

export function loadRecents() {
  return readRecentList();
}

// Name the creator typed for this room, kept with its recent entry.
export function recentBoardName(code, token) {
  const normalizedToken = token == null ? null : normalizeToken(token);
  return loadRecents().find((r) => r.code === code && r.token === normalizedToken)?.name || null;
}

export function forgetRecent(code, token) {
  const normalizedToken = token == null ? null : normalizeToken(token);
  if (!BOARD_CODE_RE.test(code || '') || token != null && !normalizedToken) return;
  try {
    const list = readRecentList();
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(list.filter((r) => !(r.code === code && r.token === normalizedToken))),
    );
  } catch { /* swallow */ }
}

// "Boards this browser created" — used to gate admin auto-election so a guest
// who happens to be the only one online in someone else's board doesn't get
// silently promoted to admin. Only the creator (or someone holding the PIN)
// can claim the role.
const CREATED_KEY = 'rb_created_boards';

const readCreatedBoards = () => {
  try {
    const raw = localStorage.getItem(CREATED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      if (typeof value.code !== 'string' || !BOARD_CODE_RE.test(value.code)) return [];
      const token = value.token == null ? null : normalizeToken(value.token);
      if (value.token != null && !token) return [];
      return [{ code: value.code, token }];
    });
  } catch { return []; }
};

export function markBoardCreated(code, token) {
  if (!BOARD_CODE_RE.test(code || '')) return;
  const normalizedToken = token == null ? null : normalizeToken(token);
  if (token != null && !normalizedToken) return;
  try {
    const list = readCreatedBoards();
    if (list.some((r) => r.code === code && r.token === normalizedToken)) return;
    list.push({ code, token: normalizedToken });
    localStorage.setItem(CREATED_KEY, JSON.stringify(list.slice(-100)));
  } catch { /* swallow */ }
}

export function isBoardCreatedByMe(code, token) {
  const normalizedToken = token == null ? null : normalizeToken(token);
  if (!BOARD_CODE_RE.test(code || '') || token != null && !normalizedToken) return false;
  return readCreatedBoards().some((r) => r.code === code && r.token === normalizedToken);
}
