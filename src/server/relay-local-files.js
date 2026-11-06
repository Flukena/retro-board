import fs from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directoryEntries = (path) => {
  try { return fs.readdirSync(path, { withFileTypes: true }); }
  catch { return []; }
};
const fileSizeBytes = (path) => {
  try { return fs.statSync(path).size; }
  catch { return 0; } // A file may disappear during compaction.
};
const excludedRootDirectory = (entry, current, root, exclusions) => (
  current === root && entry.isDirectory() && exclusions.includes(entry.name)
);

export const directorySizeSync = (root, { excludedRootDirectories = [] } = {}) => {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of directoryEntries(current)) {
      if (excludedRootDirectory(entry, current, root, excludedRootDirectories)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) total += fileSizeBytes(path);
    }
  }
  return total;
};

const SIGNING_KEY_BYTES = 32;
const MIN_ENV_KEY_BYTES = 32;
const ENCODED_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_DIRECTORY_MODE = 0o700;
const KEY_FILE_MODE = 0o600;
const ROOM_SESSION_KEY = Object.freeze({ envName: 'YJS_SESSION_SECRET', fileName: '.room-session-key' });

export const ACCOUNT_SESSION_KEY = Object.freeze({ envName: 'YJS_ACCOUNT_SESSION_SECRET', fileName: '.account-session-key' });

const readPersistedKey = (keyPath, fileName) => {
  const encoded = fs.readFileSync(keyPath, 'utf8').trim();
  const key = ENCODED_KEY_RE.test(encoded) ? Buffer.from(encoded, 'base64url') : null;
  if (key?.byteLength !== SIGNING_KEY_BYTES) throw new Error(`invalid persisted signing key ${fileName}`);
  return key;
};

const createPersistedKey = (keyPath, fileName) => {
  const encoded = randomBytes(SIGNING_KEY_BYTES).toString('base64url');
  try {
    fs.writeFileSync(keyPath, `${encoded}\n`, { flag: 'wx', mode: KEY_FILE_MODE });
    return Buffer.from(encoded, 'base64url');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return readPersistedKey(keyPath, fileName);
  }
};

/** Key from `envName`, else a persisted 0600 base64url file `fileName` in `dbDir` (created on first use). */
export const loadSigningKey = (dbDir, { envName, fileName }) => {
  const fromEnv = process.env[envName];
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'utf8');
    if (key.byteLength < MIN_ENV_KEY_BYTES) throw new Error(`${envName} must contain at least ${MIN_ENV_KEY_BYTES} bytes`);
    return key;
  }
  fs.mkdirSync(dbDir, { recursive: true, mode: KEY_DIRECTORY_MODE });
  const keyPath = join(dbDir, fileName);
  try {
    const key = readPersistedKey(keyPath, fileName);
    try { fs.chmodSync(keyPath, KEY_FILE_MODE); } catch { /* best effort on mounted filesystems */ }
    return key;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return createPersistedKey(keyPath, fileName);
};

export const loadSessionSigningKey = (dbDir) => loadSigningKey(dbDir, ROOM_SESSION_KEY);
