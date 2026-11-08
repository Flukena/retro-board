import { TOKENIZED_ROOM_RE } from './relay-room-registry.js';

const MAX_TARGET_CHARACTERS = 256;
const MAX_AWARENESS_CLIENT_ID = 0xffffffff;
const PROD_PREFIX = '/yjs/';
const PUBLIC_PREFIX_RE = /^\/yjs-public(?=\/|$)/;
const ROOM_PATH_RE = /^\/(?:yjs\/)?rooms\/([A-Za-z0-9_-]{32})(\/e2e)?$/;
const AWARENESS_QUERY_RE = /^awarenessId=(0|[1-9]\d{0,9})$/;
const PUBLIC_AWARENESS_QUERY_RE = /^awarenessId=(0|[1-9]\d{0,9})(?:&quota=1)?$/;
const QUOTA_SUFFIX = '&quota=1';
const LEGACY_ROOM_RE = /^board-[A-Za-z0-9_-]{3,32}$/;

const isPlainTarget = (target) => target.startsWith('/') && !target.startsWith('//')
  && target.length <= MAX_TARGET_CHARACTERS && !target.includes('#');

/**
 * Parses a room WebSocket target: `/rooms/<handle>[?awarenessId=n]` for y-websocket,
 * or `/rooms/<handle>/e2e` (no query) for an encrypted room. Both also answer under `/yjs`.
 * The Public Wall relay strips `/yjs-public` and never accepts the encrypted form.
 */
export function roomTargetFromRequest(req, { publicWall = false } = {}) {
  const target = req.url || '';
  if (!isPlainTarget(target)) return null;
  const queryAt = target.indexOf('?');
  const path = queryAt < 0 ? target : target.slice(0, queryAt);
  const query = queryAt < 0 ? '' : target.slice(queryAt + 1);
  const match = (publicWall ? path.replace(PUBLIC_PREFIX_RE, '') : path).match(ROOM_PATH_RE);
  if (!match) return null;
  const handle = match[1];
  if (match[2]) return publicWall || queryAt >= 0 ? null : { handle, awarenessClientId: null, supportsQuota: false, e2e: true };
  if (query === '') return { handle, awarenessClientId: null, supportsQuota: false, e2e: false };
  const awarenessMatch = query.match(publicWall ? PUBLIC_AWARENESS_QUERY_RE : AWARENESS_QUERY_RE);
  if (!awarenessMatch) return null;
  const awarenessClientId = Number(awarenessMatch[1]);
  if (awarenessClientId > MAX_AWARENESS_CLIENT_ID) return null;
  return { handle, awarenessClientId, supportsQuota: publicWall && query.endsWith(QUOTA_SUFFIX), e2e: false };
}

/**
 * Legacy URL-token paths `/board-<code>-<token>` (dev) and `/yjs/board-…` (prod).
 * Canonical persistence names keep the historic `yjs/` prefix.
 */
export function tokenDocNameFromRequest(req, { allowLegacyRooms = false } = {}) {
  const target = req.url || '';
  if (!isPlainTarget(target) || target.includes('?')) return null;
  const rawRoom = target.startsWith(PROD_PREFIX) ? target.slice(PROD_PREFIX.length) : target.slice(1);
  if (TOKENIZED_ROOM_RE.test(rawRoom)) return `yjs/${rawRoom}`;
  if (allowLegacyRooms && LEGACY_ROOM_RE.test(rawRoom)) return `yjs/${rawRoom}`;
  return null;
}
