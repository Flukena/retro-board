// Tiny pathname router for /b/<code> boards.
// No history API beyond plain navigation — each visit is a full page load.

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

export function rememberRecent(code, name, token) {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    // Match on (code, token) so a legacy tokenless recent stays distinct
    // from a token-gated one with the same code.
    const filtered = list.filter((r) => !(r.code === code && (r.token || null) === (token || null)));
    filtered.unshift({ code, token: token || null, name: name || '', visitedAt: Date.now() });
    localStorage.setItem(RECENTS_KEY, JSON.stringify(filtered.slice(0, 10)));
  } catch {
    /* swallow */
  }
}

export function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function forgetRecent(code, token) {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(list.filter((r) => !(r.code === code && (r.token || null) === (token || null)))),
    );
  } catch { /* swallow */ }
}

// "Boards this browser created" — used to gate admin auto-election so a guest
// who happens to be the only one online in someone else's board doesn't get
// silently promoted to admin. Only the creator (or someone holding the PIN)
// can claim the role.
const CREATED_KEY = 'rb_created_boards';

export function markBoardCreated(code, token) {
  try {
    const raw = localStorage.getItem(CREATED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (list.some((r) => r.code === code && (r.token || null) === (token || null))) return;
    list.push({ code, token: token || null });
    localStorage.setItem(CREATED_KEY, JSON.stringify(list.slice(-100)));
  } catch { /* swallow */ }
}

export function isBoardCreatedByMe(code, token) {
  try {
    const raw = localStorage.getItem(CREATED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return list.some((r) => r.code === code && (r.token || null) === (token || null));
  } catch { return false; }
}
