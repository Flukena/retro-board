import { isBoardTitle } from '../domain/board-title.js';
import { ROOM_KIND } from '../domain/room-ownership.js';
import { RETRY_AFTER_SHORT_SECONDS } from './relay-config.js';
import { readJsonBody, sendIfWritable, sendJson } from './relay-http.js';
import { STORAGE_FAILURE_CODE } from './relay-storage.js';
import { takeTrafficTokens, trafficBucketFor } from './relay-rate-bucket.js';
import { roomCodeOf, roomLink } from './room-links.js';
import { orphanAccountRooms } from './room-orphaning.js';
import { TITLE_WRITE_STATUS } from './room-title-writer.js';

// The signed-in creator's own rooms: list, rename, delete. auth-routes dispatches these paths with the account
// preflight, Origin policy, cookie check and no-store headers; this module decides what each request may do.

export const ACCOUNT_ROOM_ACTIONS_PER_MINUTE = 30;
const SECONDS_PER_MINUTE = 60;
const MAX_ACCOUNT_BUCKETS = 10_000;
// One token per request; byte budgets are unused.
const ACTION_LIMITS = Object.freeze({
  maxMessages: ACCOUNT_ROOM_ACTIONS_PER_MINUTE, messagesPerSecond: ACCOUNT_ROOM_ACTIONS_PER_MINUTE / SECONDS_PER_MINUTE,
  maxBytes: 0, bytesPerSecond: 0,
});
const ACTION_TOKEN_BYTES = 0;
const ROOMS_PATH = '/api/account/rooms';
const ROOM_ACTION_RE = /^\/api\/account\/rooms\/([^/]+)\/(title|delete)$/;
const ACTION = Object.freeze({ TITLE: 'title', DELETE: 'delete' });
const METHOD = Object.freeze({ GET: 'GET', POST: 'POST' });
const HTTP = Object.freeze({
  OK: 200, NO_CONTENT: 204, BAD_REQUEST: 400, NOT_FOUND: 404, CONFLICT: 409, TOO_LARGE: 413, TOO_MANY: 429,
  UNAVAILABLE: 503,
});
const BODY_TOO_LARGE = 'BODY_TOO_LARGE';
const LOCKED_ROOM_BODY = Object.freeze({ error: 'locked-room' });
const NO_SUMMARY = Object.freeze({ title: null, preview: null });
const TITLE_KEYS = ['title'];
const DELETE_KEYS = ['confirmCode'];

const hasOnlyKeys = (body, keys) => Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));
const newestFirst = (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0);
// Missing, someone else's, unowned (the Public Wall) and malformed rooms all leave through here: one identical answer.
const notFound = (res) => sendIfWritable(res, HTTP.NOT_FOUND);
const tooManyRequests = (res) => sendIfWritable(res, HTTP.TOO_MANY, { 'retry-after': String(RETRY_AFTER_SHORT_SECONDS) });

/**
 * Ports: registry (RoomRegistry), store (AccountStore), readSummary(docName) → { title, preview }, writeTitle(docName, title) →
 * TITLE_WRITE_STATUS, deleteRoom(docName) → RoomDeletion result, maxBodyBytes, onStorageFailure, log.
 * @returns {{ routeFor(routePath: string): ({ method: string, run: Function }|null), orphanRoomsOf(accountId: string): Promise<number> }}
 */
export function createAccountRoomRoutes({
  registry, store, readSummary, writeTitle, deleteRoom, maxBodyBytes, onStorageFailure = () => {}, log = console,
}) {
  const buckets = new Map();
  const takeToken = (accountId) => takeTrafficTokens(
    trafficBucketFor(buckets, accountId, ACTION_LIMITS, MAX_ACCOUNT_BUCKETS), ACTION_TOKEN_BYTES, ACTION_LIMITS,
  );
  // The admission point: a logout-all or account delete admitted before this answers 401 from here on.
  const stillSignedIn = (account) => store.checkGeneration(account.id, account.sessionGeneration);
  const ownedDocName = (accountId, code) => registry.roomsOwnedBy(accountId).find((docName) => roomCodeOf(docName) === code) ?? null;

  async function entryOf(docName) {
    const ownership = registry.ownershipOf(docName);
    if (!ownership) return null;
    const { kind, locked, record } = ownership;
    const summary = locked ? NO_SUMMARY : await readSummary(docName);
    // Deleted while its summary was read.
    if (!registry.ownershipOf(docName)) return null;
    const activity = registry.activity.get(docName);
    return {
      code: roomCodeOf(docName), kind, locked, title: summary.title,
      preview: kind === ROOM_KIND.BOARD ? summary.preview : null, link: roomLink(docName, kind),
      createdAt: record?.createdAt ?? activity.createdAt, lastActiveAt: activity.lastActiveAt,
    };
  }

  async function list(_req, res, { account, unauthorized }) {
    if (!takeToken(account.id)) { tooManyRequests(res); return; }
    if (!(await stillSignedIn(account))) { unauthorized(); return; }
    let rooms;
    try {
      rooms = await Promise.all(registry.roomsOwnedBy(account.id).map(entryOf));
    } catch (error) {
      // Latched like any storage failure; the dispatcher answers 503.
      if (error.code === STORAGE_FAILURE_CODE) onStorageFailure(error);
      throw error;
    }
    sendJson(res, HTTP.OK, { rooms: rooms.filter(Boolean).sort(newestFirst) });
  }

  // The parsed request, or null once the refusal has been sent.
  async function readRequest(req, res, parse) {
    let body;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      sendIfWritable(res, error.code === BODY_TOO_LARGE ? HTTP.TOO_LARGE : HTTP.BAD_REQUEST);
      return null;
    }
    const request = parse(body);
    if (!request) sendIfWritable(res, HTTP.BAD_REQUEST);
    return request;
  }

  async function rename(res, docName, { title }) {
    if (registry.ownershipOf(docName).locked) { sendJson(res, HTTP.CONFLICT, LOCKED_ROOM_BODY); return; }
    const status = await writeTitle(docName, title);
    if (status === TITLE_WRITE_STATUS.OK) sendJson(res, HTTP.OK, { title });
    else if (status === TITLE_WRITE_STATUS.NOT_FOUND) notFound(res);
    else sendIfWritable(res, HTTP.UNAVAILABLE);
  }

  async function remove(res, docName) {
    const result = await deleteRoom(docName);
    if (result.deleted) sendIfWritable(res, HTTP.NO_CONTENT);
    else if (result.status === HTTP.NOT_FOUND) notFound(res);
    else sendIfWritable(res, HTTP.UNAVAILABLE);
  }

  const actions = {
    [ACTION.TITLE]: { parse: (body) => (hasOnlyKeys(body, TITLE_KEYS) && isBoardTitle(body.title) ? body : null), act: rename },
    [ACTION.DELETE]: { parse: (body, code) => (hasOnlyKeys(body, DELETE_KEYS) && body.confirmCode === code ? body : null), act: remove },
  };

  const roomAction = ({ parse, act }, code) => async (req, res, { account, unauthorized }) => {
    if (!takeToken(account.id)) { tooManyRequests(res); return; }
    const request = await readRequest(req, res, (body) => parse(body, code));
    if (!request) return;
    if (!(await stillSignedIn(account))) { unauthorized(); return; }
    const docName = ownedDocName(account.id, code);
    if (!docName) { notFound(res); return; }
    await act(res, docName, request);
  };

  return {
    /** The route of an account-rooms path, or null for any other path. */
    routeFor(routePath) {
      if (routePath === ROOMS_PATH) return { method: METHOD.GET, run: list };
      const match = ROOM_ACTION_RE.exec(routePath);
      if (!match) return null;
      const [, code, action] = match;
      return { method: METHOD.POST, run: roomAction(actions[action], code) };
    },
    /** Orphans every room of an account that was just deleted. */
    orphanRoomsOf: (accountId) => orphanAccountRooms({ registry, accountId, log, onStorageFailure }),
  };
}
