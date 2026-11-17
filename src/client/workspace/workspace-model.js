import { boardPreviewFromItems } from '../../domain/board-preview.js';
import { ROOM_KIND } from '../../domain/room-ownership.js';

export const WORKSPACE_SORT = Object.freeze({ RECENT: 'recent', CREATED: 'created', NAME: 'name' });
export const CARD_THUMBNAIL = Object.freeze({ ZONES: 'zones', LOCKED: 'locked', POKER: 'poker', EMPTY: 'empty' });
export const RENAME_ACTION = Object.freeze({ ENABLED: 'enabled', DISABLED: 'disabled', HIDDEN: 'hidden' });

const EMPTY_THUMBNAIL = Object.freeze({ kind: CARD_THUMBNAIL.EMPTY, zones: Object.freeze([]) });

// Locked and Poker rooms never show a title: the code is their name.
export const roomNameOf = (room) =>
  room.locked || room.kind === ROOM_KIND.POKER ? room.code : room.title || room.code;

const matchesQuery = (room, needle) =>
  roomNameOf(room).toLowerCase().includes(needle) || room.code.toLowerCase().includes(needle);

const byCode = (a, b) => (a.code < b.code ? -1 : Number(a.code > b.code));
const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const MISSING_TIME_MS = 0;
const createdOf = (room) => finiteOr(room.createdAt, MISSING_TIME_MS);
const lastActiveOf = (room) => finiteOr(room.lastActiveAt, createdOf(room));

const comparatorFor = (sort, locale) => {
  if (sort === WORKSPACE_SORT.NAME) {
    return (a, b) => roomNameOf(a).localeCompare(roomNameOf(b), locale) || byCode(a, b);
  }
  const timeOf = sort === WORKSPACE_SORT.CREATED ? createdOf : lastActiveOf;
  return (a, b) => timeOf(b) - timeOf(a) || byCode(a, b);
};

export const visibleRooms = (rooms, { query = '', sort = WORKSPACE_SORT.RECENT, locale } = {}) => {
  const needle = query.trim().toLowerCase();
  const matching = needle ? rooms.filter((room) => matchesQuery(room, needle)) : [...rooms];
  return matching.sort(comparatorFor(sort, locale));
};

const asZoneItem = (zone) => ({ type: 'zone', x: zone?.x, y: zone?.y, w: zone?.w, h: zone?.h, color: zone?.color });

// The relay already validated, but the client never trusts a payload it renders.
const revalidatedZones = (preview) => {
  if (!preview || typeof preview !== 'object' || !Array.isArray(preview.zones)) return null;
  return boardPreviewFromItems(preview.zones.map(asZoneItem))?.zones ?? null;
};

export const cardThumbnailOf = (room) => {
  if (room.kind === ROOM_KIND.POKER) return { kind: CARD_THUMBNAIL.POKER, zones: [] };
  if (room.locked) return { kind: CARD_THUMBNAIL.LOCKED, zones: [] };
  const zones = revalidatedZones(room.preview);
  return zones ? { kind: CARD_THUMBNAIL.ZONES, zones } : EMPTY_THUMBNAIL;
};

export const renameActionOf = (room) => {
  if (room.kind === ROOM_KIND.POKER) return RENAME_ACTION.HIDDEN;
  return room.locked ? RENAME_ACTION.DISABLED : RENAME_ACTION.ENABLED;
};
