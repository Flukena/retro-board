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

export const loadSessionSigningKey = (DB_DIR) => {
  const fromEnv = process.env.YJS_SESSION_SECRET;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'utf8');
    if (key.byteLength < 32) throw new Error('YJS_SESSION_SECRET must contain at least 32 bytes');
    return key;
  }
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  const keyPath = join(DB_DIR, '.room-session-key');
  const readKey = () => {
    const encoded = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('invalid persisted room session key');
    const key = Buffer.from(encoded, 'base64url');
    if (key.byteLength !== 32) throw new Error('invalid persisted room session key');
    return key;
  };
  try {
    const key = readKey();
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort on mounted filesystems */ }
    return key;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const encoded = randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(keyPath, `${encoded}\n`, { flag: 'wx', mode: 0o600 });
    return Buffer.from(encoded, 'base64url');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return readKey();
  }
};

