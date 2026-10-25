export const PUBLIC_SNAPSHOT_INTERVAL_MS = 10_000;
export const PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX = 1_200;
export const PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX = 720;
export const PUBLIC_MAX_ITEMS = 1_500;
export const PUBLIC_WRITER_CAP = 500;
export const PUBLIC_RELAY_PREFIX = '/yjs-public';
export const PUBLIC_PATH = '/public';
export const PUBLIC_ITEM_TYPES = Object.freeze(['sticky', 'text', 'zone', 'image']);
export const PUBLIC_TEXT_MAX_CHARACTERS = 2_000;

export const BOARD_MODE = Object.freeze({ PUBLIC: 'public', PRIVATE: 'private' });
export const PUBLIC_SESSION_ROUTE = '/api/public-session';
export const PUBLIC_SNAPSHOT_ROUTE = '/api/snapshot';
export const PUBLIC_ROOM_SESSION_SUFFIX = '/public-session';
