import { resolve, relative, isAbsolute, sep } from 'node:path';

import { envBool, MILLISECONDS_PER_HOUR, MILLISECONDS_PER_MINUTE } from './relay-config.js';
import { PUBLIC_WRITER_CAP } from '../domain/public-wall-contract.js';

export { PUBLIC_SNAPSHOT_INTERVAL_MS, PUBLIC_MAX_ITEMS, PUBLIC_WRITER_CAP, PUBLIC_RELAY_PREFIX, PUBLIC_PATH } from '../domain/public-wall-contract.js';
export const PUBLIC_BACKUP_INTERVAL_MS = MILLISECONDS_PER_HOUR;
export const PUBLIC_BACKUP_RETENTION_COUNT = 48;
export const PUBLIC_BACKUP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const PUBLIC_CREATED_AT_CLOCK_SKEW_MS = MILLISECONDS_PER_MINUTE;
export const PUBLIC_MAX_DATABASE_BYTES = 256 * 1024 * 1024;
export const PUBLIC_RELAY_PORT = 1235;
export const PUBLIC_DIRECTORY_MARKER = '.public-wall-v1';
export const PUBLIC_SNAPSHOT_DIRECTORY = 'snapshots';
export const PUBLIC_BACKUP_FILE_PATTERN = /^wall-\d{13}\.bin$/;
export const PUBLIC_BACKUP_TEMP_FILE_PATTERN = /^wall-\d{13}\.bin\.tmp$/;
export const PUBLIC_PRUNE_ORIGIN = 'public-prune';
const MAIN_DEFAULT_DB_DIRECTORY = './yjs-db';
const PRIVATE_UPLOAD_DIRECTORY = './uploads';
const PUBLIC_UPLOAD_DIRECTORY_SUFFIX = '-uploads';
const PUBLIC_ROOM_COUNT = 1;

export const isPublicWallEnabled = (env) => envBool('YJS_PUBLIC_WALL', false, env);

function containsDirectory(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function publicUploadDirectory(env) {
  const database = resolve(env.YJS_DB_DIR);
  const uploads = resolve(env.YJS_UPLOADS_DIR || `${database}${PUBLIC_UPLOAD_DIRECTORY_SUFFIX}`);
  if (uploads === resolve(PRIVATE_UPLOAD_DIRECTORY)
    || containsDirectory(database, uploads) || containsDirectory(uploads, database)) {
    throw new Error('Public upload directory must be isolated from the database and private uploads');
  }
  return uploads;
}

export function publicRelayEnvironment(env) {
  if (!isPublicWallEnabled(env)) return env;
  if (!env.YJS_DB_DIR || resolve(env.YJS_DB_DIR) === resolve(MAIN_DEFAULT_DB_DIRECTORY)) {
    throw new Error('Public wall requires its own explicit data directory');
  }
  return {
    ...env,
    YJS_MAX_CONNECTIONS_PER_ROOM: String(PUBLIC_WRITER_CAP),
    YJS_MAX_REGISTERED_ROOMS: String(PUBLIC_ROOM_COUNT),
    YJS_MAX_DB_BYTES: env.YJS_MAX_DB_BYTES || String(PUBLIC_MAX_DATABASE_BYTES),
    YJS_UPLOADS_DIR: publicUploadDirectory(env),
    YJS_ALLOW_LEGACY_ROOMS: 'false',
    YJS_ALLOW_LEGACY_URL_TOKENS: 'false',
  };
}
