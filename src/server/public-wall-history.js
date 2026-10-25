import fs from 'node:fs';
import { join } from 'node:path';
import {
  PUBLIC_DIRECTORY_MARKER, PUBLIC_SNAPSHOT_DIRECTORY, PUBLIC_BACKUP_FILE_PATTERN,
  PUBLIC_BACKUP_INTERVAL_MS, PUBLIC_BACKUP_RETENTION_COUNT, PUBLIC_BACKUP_MAX_TOTAL_BYTES, PUBLIC_BACKUP_TEMP_FILE_PATTERN,
} from './public-wall-config.js';

const PUBLIC_MARKER_CONTENT = 'retro-public-wall-v1\n';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export function claimPublicDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const marker = join(directory, PUBLIC_DIRECTORY_MARKER);
  if (fs.existsSync(marker)) {
    if (fs.readFileSync(marker, 'utf8') !== PUBLIC_MARKER_CONTENT) throw new Error('Invalid public wall directory marker');
    return;
  }
  if (fs.readdirSync(directory).length) throw new Error('Refusing unmarked public wall directory');
  fs.writeFileSync(marker, PUBLIC_MARKER_CONTENT, { flag: 'wx', mode: PRIVATE_FILE_MODE });
}

export function requirePublicDirectory(directory) {
  if (fs.readFileSync(join(directory, PUBLIC_DIRECTORY_MARKER), 'utf8') !== PUBLIC_MARKER_CONTENT) {
    throw new Error('Not a public wall directory');
  }
}

export class PublicWallHistory {
  #directory;
  #maxTotalBytes;
  #Y;
  #lastWrittenAtMs = -Infinity;
  #dirty = true;
  #doc = null;
  #changed = () => { this.#dirty = true; };
  #running = false;

  constructor(directory, Y, { maxTotalBytes = PUBLIC_BACKUP_MAX_TOTAL_BYTES } = {}) {
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) throw new Error('Invalid public history byte budget');
    this.#maxTotalBytes = maxTotalBytes;
    this.#directory = join(directory, PUBLIC_SNAPSHOT_DIRECTORY);
    this.#Y = Y;
  }

  async maintain(doc, nowMs = Date.now()) {
    if (this.#running) return;
    if (doc !== this.#doc) {
      this.#doc?.off('update', this.#changed);
      this.#doc = doc;
      doc.on('update', this.#changed);
      this.#dirty = true;
    }
    if (!this.#dirty || nowMs - this.#lastWrittenAtMs < PUBLIC_BACKUP_INTERVAL_MS) return;
    this.#running = true;
    this.#dirty = false;
    try {
      await this.#write(doc, nowMs);
      this.#lastWrittenAtMs = nowMs;
    } catch (error) {
      this.#dirty = true;
      throw error;
    } finally {
      this.#running = false;
    }
  }

  async #write(doc, nowMs) {
    const bytes = this.#Y.encodeStateAsUpdate(doc);
    if (bytes.byteLength > this.#maxTotalBytes) throw new Error('Snapshot exceeds public history byte budget');
    await fs.promises.mkdir(this.#directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await this.#trim(bytes.byteLength, 1);
    const target = join(this.#directory, `wall-${nowMs}.bin`);
    const temp = `${target}.tmp`;
    try {
      await fs.promises.writeFile(temp, bytes, { mode: PRIVATE_FILE_MODE });
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
    await this.#trim(0, 0);
  }

  async #trim(incomingBytes, incomingCount) {
    const names = await fs.promises.readdir(this.#directory);
    for (const name of names.filter(name => PUBLIC_BACKUP_TEMP_FILE_PATTERN.test(name))) {
      await fs.promises.unlink(join(this.#directory, name));
    }
    const files = names.filter(name => PUBLIC_BACKUP_FILE_PATTERN.test(name)).sort();
    const entries = await Promise.all(files.map(async name => ({ name,
      bytes: (await fs.promises.stat(join(this.#directory, name))).size,
    })));
    let totalBytes = entries.reduce((total, entry) => total + entry.bytes, incomingBytes);
    let totalCount = entries.length + incomingCount;
    for (const entry of entries) {
      if (totalBytes <= this.#maxTotalBytes && totalCount <= PUBLIC_BACKUP_RETENTION_COUNT) break;
      await fs.promises.unlink(join(this.#directory, entry.name));
      totalBytes -= entry.bytes;
      totalCount--;
    }
  }
}
