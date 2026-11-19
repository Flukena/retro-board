// Tiny pathname router for /b/<code> boards.
// No history API beyond plain navigation — each visit is a full page load.

import { PUBLIC_PATH } from '../../domain/public-wall-contract.js';
import { ROOM_KIND, roomPath } from '../../domain/room-ownership.js';
import { legalPageForPath } from '../legal/legal-content.js';
import { TEMPLATE_PATH_PREFIX, starterFormat } from '../templates/starter-formats.js';
import { AGILE_GUIDE_PATH, PLANNING_POKER_PATH, splitLangPath } from '../seo/seo-pages.js';

const BOARD_PATH = /^\/b\/([A-Za-z0-9_-]{3,32})\/?$/;
const POKER_PATH = /^\/p\/([A-Za-z0-9_-]{3,32})\/?$/;

export { ROOM_KIND };
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

// Content pages also exist under a language prefix (/th/...), which sets the
// page language. Boards and the Public Wall have no language prefix.
export function parseRoute() {
  const urlPath = (typeof window !== 'undefined' ? window.location.pathname : '/') || '/';
  const { lang, path } = splitLangPath(urlPath);
  const content = contentRoute(path);
  if (content) return lang ? { ...content, lang } : content;
  if (lang) return { kind: 'notFound' };
  if (path === PUBLIC_PATH || path === `${PUBLIC_PATH}/`) return { kind: 'public' };
  const m = path.match(BOARD_PATH);
  if (m) return { kind: ROOM_KIND.BOARD, code: m[1], token: readTokenFromHash() };
  const poker = path.match(POKER_PATH);
  if (poker) return { kind: ROOM_KIND.POKER, code: poker[1], token: readTokenFromHash() };
  return { kind: 'notFound' };
}

function contentRoute(path) {
  const legalPage = legalPageForPath(path);
  if (legalPage) return { kind: 'legal', page: legalPage };
  if (LANDING_PATHS.has(path)) return { kind: 'landing' };
  const trimmed = path.replace(/\/$/, '');
  if (trimmed === PLANNING_POKER_PATH) return { kind: 'pokerGuide' };
  if (trimmed === AGILE_GUIDE_PATH) return { kind: 'agileGuide' };
  const slug = templateSlugForPath(path);
  if (slug) return { kind: 'template', slug };
  return null;
}

const LANDING_PATHS = new Set(['/', '/index.html']);

/** Whether a URL path is the home page, in any language ('/', '/index.html', '/th', ...). */
export function isLandingPath(pathname) {
  return LANDING_PATHS.has(splitLangPath(pathname).path);
}

function templateSlugForPath(path) {
  if (!path.startsWith(TEMPLATE_PATH_PREFIX)) return null;
  const slug = path.slice(TEMPLATE_PATH_PREFIX.length).replace(/\/$/, '');
  return starterFormat(slug) ? slug : null;
}

// Build a full share URL. `token` is optional; without it the link is the
// legacy /b/CODE form and resolves to the pre-token doc name.
export function buildBoardUrl(code, token, kind = ROOM_KIND.BOARD) {
  return `${window.location.origin}${roomPath(code, token, kind)}`;
}

export function gotoBoard(code, token, kind = ROOM_KIND.BOARD) {
  window.location.href = roomPath(code, token, kind);
}

export function gotoLanding() {
  window.location.href = '/';
}

const RECENTS_KEY = 'rb_recents';
const BOARD_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const RECENT_NAME_MAX_LENGTH = 120;

// Entries saved before poker rooms existed have no kind; they are boards.
const recentKind = (value) => (value === ROOM_KIND.POKER ? ROOM_KIND.POKER : ROOM_KIND.BOARD);

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
    kind: recentKind(value.kind),
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

export function rememberRecent(code, name, token, kind = ROOM_KIND.BOARD) {
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
      kind: recentKind(kind),
    });
    localStorage.setItem(RECENTS_KEY, JSON.stringify(filtered.slice(0, 10)));
  } catch {
    /* swallow */
  }
}

export function loadRecents() {
  return readRecentList();
}

export function recentsOfKind(kind) {
  return readRecentList().filter((recent) => recent.kind === kind);
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
