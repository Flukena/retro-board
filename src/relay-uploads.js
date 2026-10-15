import fs from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { EventEmitter } from 'events';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { MILLISECONDS_PER_SECOND, RETRY_AFTER_SHORT_SECONDS, ROOM_HANDLE_RE } from './relay-config.js';
import { evictOldestBucket, refillTokens, createTrafficBucket, trafficBucketFor, takeTrafficBudget } from './relay-rate-bucket.js';
import { acceptCredentialOrigin } from './relay-http.js';
import { roomLogId } from './relay-log-id.js';

// SVG is intentionally excluded — same-origin user-uploaded SVG can embed
// <script>, a stored-XSS vector this stack has no sanitizer for.
export const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const EXT_CONTENT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const IMAGE_ID_RE = /^[a-f0-9-]+\.(png|jpe?g|webp|gif)$/;
const LEGACY_IMAGE_FILENAME_RE = IMAGE_ID_RE;
const ROOM_IMAGE_FILENAME_RE = /^[A-Za-z0-9_-]{32}\.[a-f0-9-]+\.(png|jpe?g|webp|gif)$/;
export const isStoredImageFilename = (name) => (
  LEGACY_IMAGE_FILENAME_RE.test(name) || ROOM_IMAGE_FILENAME_RE.test(name)
);

// Cheap magic-byte sniff — Content-Type is client-supplied and spoofable, so
// this guards against a mislabeled/malicious body before it's written to disk.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_SIGNATURE_BYTES = 6;
const WEBP_SIGNATURE_BYTES = 12;
const RIFF_SIGNATURE_BYTES = 4;
const WEBP_FORMAT_OFFSET_BYTES = 8;
export const IMAGE_SNIFF_BYTES = WEBP_SIGNATURE_BYTES;
const ROOM_HANDLE_CHARACTERS = 32;
const PRIVATE_UPLOAD_FILE_MODE = 0o600;
export const UPLOAD_STORAGE_FAILURE_EVENT = 'storageFailure';
export const ROOM_UPLOAD_USAGE_META = 'retro-room-upload-usage-v1';

const startsWithSignature = (buf, signature) => (
  buf.length >= signature.length && buf.subarray(0, signature.length).equals(signature)
);
export const matchesMagicBytes = (buf, mime) => {
  if (mime === 'image/png') return startsWithSignature(buf, PNG_SIGNATURE);
  if (mime === 'image/jpeg') return startsWithSignature(buf, JPEG_SIGNATURE);
  if (mime === 'image/gif') return buf.length >= GIF_SIGNATURE_BYTES
    && ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, GIF_SIGNATURE_BYTES));
  if (mime === 'image/webp') return buf.length >= WEBP_SIGNATURE_BYTES
    && buf.toString('ascii', 0, RIFF_SIGNATURE_BYTES) === 'RIFF'
    && buf.toString('ascii', WEBP_FORMAT_OFFSET_BYTES, WEBP_SIGNATURE_BYTES) === 'WEBP';
  return false;
};

const accountScannedFile = (entry, uploadsDir, usage) => {
  if (!entry.isFile()) return;
  try {
    const size = fs.statSync(join(uploadsDir, entry.name)).size;
    usage.bytes += size;
    if (!isStoredImageFilename(entry.name)) return;
    usage.files += 1;
    if (!ROOM_IMAGE_FILENAME_RE.test(entry.name)) return;
    const handle = entry.name.slice(0, ROOM_HANDLE_CHARACTERS);
    const room = usage.roomsByHandle.get(handle) || { bytes: 0, files: 0 };
    room.bytes += size;
    room.files += 1;
    usage.roomsByHandle.set(handle, room);
  } catch (err) {
    usage.complete = false;
    console.error('[yjs] upload file stat failed', { fileId: roomLogId(entry.name), err: err.message });
  }
};

export const scanUploadUsage = ({ UPLOADS_DIR, MAX_UPLOAD_STORAGE_BYTES, MAX_UPLOAD_FILES }) => {
  const usage = { bytes: 0, files: 0, roomsByHandle: new Map(), complete: true };
  let entries;
  try { entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true }); }
  catch (err) {
    console.error('[yjs] upload usage scan failed', { err: err.message });
    usage.complete = false;
  }
  for (const entry of entries || []) accountScannedFile(entry, UPLOADS_DIR, usage);
  if (!usage.complete) {
    usage.bytes = MAX_UPLOAD_STORAGE_BYTES;
    usage.files = MAX_UPLOAD_FILES;
  }
  return usage;
};

export const createUploadState = (config) => {
  const initialUsage = scanUploadUsage(config);
  return {
    initialUsage, bytes: initialUsage.bytes, files: initialUsage.files,
    reservedBytes: 0, active: 0, activeByIp: new Map(), buckets: new Map(),
    events: new EventEmitter(),
  };
};

export const createImageReadBudgets = (config) => {
  const { GLOBAL_IMAGE_READS_PER_SECOND, GLOBAL_IMAGE_READ_BURST, GLOBAL_IMAGE_READ_BURST_BYTES, GLOBAL_IMAGE_READ_BYTES_PER_SECOND, IMAGE_READS_PER_SECOND, IMAGE_READ_BURST, IMAGE_READ_BURST_BYTES, IMAGE_READ_BYTES_PER_SECOND, ROOM_IMAGE_READS_PER_SECOND, ROOM_IMAGE_READ_BURST, ROOM_IMAGE_READ_BURST_BYTES, ROOM_IMAGE_READ_BYTES_PER_SECOND, MAX_BUCKETS } = config;
  const imageReadIpLimits = {
    maxMessages: IMAGE_READ_BURST,
    messagesPerSecond: IMAGE_READS_PER_SECOND,
    maxBytes: IMAGE_READ_BURST_BYTES,
    bytesPerSecond: IMAGE_READ_BYTES_PER_SECOND,
  };
  const imageReadRoomLimits = {
    maxMessages: ROOM_IMAGE_READ_BURST,
    messagesPerSecond: ROOM_IMAGE_READS_PER_SECOND,
    maxBytes: ROOM_IMAGE_READ_BURST_BYTES,
    bytesPerSecond: ROOM_IMAGE_READ_BYTES_PER_SECOND,
  };
  const imageReadGlobalLimits = {
    maxMessages: GLOBAL_IMAGE_READ_BURST,
    messagesPerSecond: GLOBAL_IMAGE_READS_PER_SECOND,
    maxBytes: GLOBAL_IMAGE_READ_BURST_BYTES,
    bytesPerSecond: GLOBAL_IMAGE_READ_BYTES_PER_SECOND,
  };
  const imageReadIpBuckets = new Map();
  const imageReadRoomBuckets = new Map();
  const globalImageReadBucket = createTrafficBucket(
    imageReadGlobalLimits.maxMessages,
    imageReadGlobalLimits.maxBytes,
  );
  const take = (clientIp, roomKey, bytes) => takeTrafficBudget([
    {
      bucket: trafficBucketFor(imageReadIpBuckets, clientIp, imageReadIpLimits, MAX_BUCKETS),
      size: bytes,
      limits: imageReadIpLimits,
    },
    {
      bucket: trafficBucketFor(imageReadRoomBuckets, roomKey, imageReadRoomLimits, MAX_BUCKETS),
      size: bytes,
      limits: imageReadRoomLimits,
    },
    { bucket: globalImageReadBucket, size: bytes, limits: imageReadGlobalLimits },
  ]);

  return { take, ipBuckets: imageReadIpBuckets, roomBuckets: imageReadRoomBuckets };
};

export const createRelayUploads = ({ config, state, roomUploadUsage, imageReads, storage, allowedOrigins, allowInsecureHttp }) => {
  const {
    UPLOADS_DIR, UPLOAD_RL_MAX, UPLOAD_RL_REFILL_PER_SEC, MAX_BUCKETS,
    MAX_UPLOAD_BYTES, MAX_ACTIVE_UPLOADS, MAX_ACTIVE_UPLOADS_PER_IP,
    MAX_UPLOAD_FILES, MAX_UPLOAD_STORAGE_BYTES, MAX_ROOM_UPLOAD_FILES,
    MAX_ROOM_UPLOAD_BYTES, REQUEST_TIMEOUT_MS,
  } = config;
  const takeUploadToken = (ip) => {
    const now = Date.now();
    let b = state.buckets.get(ip);
    if (!b) {
      evictOldestBucket(state.buckets, MAX_BUCKETS);
      b = { tokens: UPLOAD_RL_MAX, last: now, lastSeen: now };
      state.buckets.set(ip, b);
    }
    b.tokens = refillTokens(b.tokens, UPLOAD_RL_MAX, now - b.last, UPLOAD_RL_REFILL_PER_SEC, MILLISECONDS_PER_SECOND);
    b.last = now;
    b.lastSeen = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const releaseUpload = (ip, reservedBytes, docName) => {
    state.active = Math.max(0, state.active - 1);
    state.reservedBytes = Math.max(0, state.reservedBytes - reservedBytes);
    const next = (state.activeByIp.get(ip) || 1) - 1;
    if (next > 0) state.activeByIp.set(ip, next);
    else state.activeByIp.delete(ip);
    const room = roomUploadUsage.get(docName);
    if (room) {
      room.active = Math.max(0, room.active - 1);
      room.reservedBytes = Math.max(0, room.reservedBytes - reservedBytes);
    }
  };

  const uploadError = (code, message) => Object.assign(new Error(message), { code });

  const uploadHeaders = (req, res) => {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    const ext = MIME_EXT[contentType];
    if (!ext) { res.writeHead(415, { 'content-type': 'text/plain' }); res.end('unsupported media type'); return null; }
    const rawLength = req.headers['content-length'];
    if (rawLength != null && !/^\d+$/.test(String(rawLength))) { res.writeHead(400); res.end(); return null; }
    const declaredLength = rawLength == null ? null : Number(rawLength);
    if (declaredLength != null && declaredLength > MAX_UPLOAD_BYTES) { res.writeHead(413); res.end(); return null; }
    return { contentType, ext, declaredLength };
  };

  const reserveUpload = (clientIp, docName, declaredLength, res) => {
    if (state.active >= MAX_ACTIVE_UPLOADS
        || (state.activeByIp.get(clientIp) || 0) >= MAX_ACTIVE_UPLOADS_PER_IP) {
      res.writeHead(429, { 'retry-after': RETRY_AFTER_SHORT_SECONDS });
      res.end();
      return null;
    }
    const reservedBytes = declaredLength ?? MAX_UPLOAD_BYTES;
    const room = roomUploadUsage.get(docName);
    if (!room) { res.writeHead(404); res.end(); return null; }
    if (state.files + state.active >= MAX_UPLOAD_FILES
        || state.bytes + state.reservedBytes + reservedBytes > MAX_UPLOAD_STORAGE_BYTES) {
      res.writeHead(507, { 'content-type': 'text/plain' });
      res.end('upload capacity reached');
      return null;
    }
    if (room.files + room.active >= MAX_ROOM_UPLOAD_FILES
        || room.bytes + room.reservedBytes + reservedBytes > MAX_ROOM_UPLOAD_BYTES) {
      res.writeHead(507, { 'content-type': 'text/plain' });
      res.end('room upload capacity reached');
      return null;
    }
    state.active += 1;
    state.activeByIp.set(clientIp, (state.activeByIp.get(clientIp) || 0) + 1);
    state.reservedBytes += reservedBytes;
    room.active += 1;
    room.reservedBytes += reservedBytes;
    return { room, reservedBytes };
  };

  const createTransfer = (ext, roomHandle) => {
    const id = randomUUID();
    const imageId = `${id}.${ext}`;
    const filename = `${roomHandle}.${imageId}`;
    const transfer = {
      imageId, filename,
      tempPath: join(UPLOADS_DIR, `.upload-${id}.tmp`),
      finalPath: join(UPLOADS_DIR, filename),
      total: 0, prefix: Buffer.alloc(0), published: false, accounted: false, timedOut: false,
    };
    transfer.meter = new Transform({
      transform(chunk, _encoding, callback) {
        transfer.total += chunk.length;
        if (transfer.total > MAX_UPLOAD_BYTES) {
          callback(uploadError('UPLOAD_TOO_LARGE', 'upload too large'));
          return;
        }
        if (transfer.prefix.length < IMAGE_SNIFF_BYTES) {
          transfer.prefix = Buffer.concat([transfer.prefix, chunk.subarray(0, IMAGE_SNIFF_BYTES - transfer.prefix.length)]);
        }
        callback(null, chunk);
      },
    });
    return transfer;
  };

  const publishUpload = async (transfer, req, res, contentType, reservation, docName, roomHandle) => {
    const { room } = reservation;
    await pipeline(req, transfer.meter, fs.createWriteStream(transfer.tempPath, { flags: 'wx', mode: PRIVATE_UPLOAD_FILE_MODE }));
    if (!matchesMagicBytes(transfer.prefix, contentType)) throw uploadError('INVALID_IMAGE', 'invalid image data');
    // Reservations cover publication; rename remains atomic within the upload directory.
    await fs.promises.rename(transfer.tempPath, transfer.finalPath);
    transfer.published = true;
    state.bytes += transfer.total;
    state.files += 1;
    room.bytes += transfer.total;
    room.files += 1;
    transfer.accounted = true;
    try {
      await storage.setMeta(docName, ROOM_UPLOAD_USAGE_META, { bytes: room.bytes, files: room.files });
    } catch (err) {
      state.events.emit(UPLOAD_STORAGE_FAILURE_EVENT, err);
      throw uploadError('UPLOAD_META', 'upload accounting failed');
    }
    console.log('[yjs] upload stored', { fileId: roomLogId(transfer.filename), bytes: transfer.total });
    res.writeHead(200, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify({ url: `/rooms/${roomHandle}/images/${transfer.imageId}` }));
  };

  const removePublishedFile = async (transfer) => {
    try {
      await fs.promises.unlink(transfer.finalPath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      console.error('[yjs] upload publish rollback failed', { fileId: roomLogId(transfer.filename), err: err.message });
      return false;
    }
  };

  const rollbackUpload = async (transfer, room, err) => {
    if (!transfer.published || err.code !== 'UPLOAD_META') return;
    const removed = await removePublishedFile(transfer);
    // Failed removal retains conservative accounting until startup reconciliation.
    if (removed && transfer.accounted) {
      state.bytes = Math.max(0, state.bytes - transfer.total);
      state.files = Math.max(0, state.files - 1);
      room.bytes = Math.max(0, room.bytes - transfer.total);
      room.files = Math.max(0, room.files - 1);
      transfer.accounted = false;
    }
  };

  const failUpload = async (transfer, req, res, room, err) => {
    await rollbackUpload(transfer, room, err);
    try { await fs.promises.unlink(transfer.tempPath); } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') console.warn('[yjs] upload temp cleanup failed', { err: cleanupErr.message });
    }
    if (res.destroyed || req.destroyed && transfer.timedOut) return;
    if (err.code === 'UPLOAD_TOO_LARGE') res.writeHead(413);
    else if (err.code === 'INVALID_IMAGE') res.writeHead(422, { 'content-type': 'text/plain' });
    else if (err.code === 'UPLOAD_TIMEOUT' || transfer.timedOut) res.writeHead(408);
    else {
      console.error('[yjs] upload write failed', { err: err.message });
      res.writeHead(500);
    }
    res.end(err.code === 'INVALID_IMAGE' ? 'invalid image data' : undefined);
  };

  const handleUpload = async (req, res, clientIp, docName, roomHandle) => {
    if (!acceptCredentialOrigin(req, res, allowedOrigins, allowInsecureHttp)) return;
    if (!takeUploadToken(clientIp)) { res.writeHead(429); res.end(); return; }
    const headers = uploadHeaders(req, res);
    if (!headers) return;
    const reservation = reserveUpload(clientIp, docName, headers.declaredLength, res);
    if (!reservation) return;
    const { room, reservedBytes } = reservation;
    const transfer = createTransfer(headers.ext, roomHandle);
    const deadline = setTimeout(() => {
      transfer.timedOut = true;
      req.destroy(uploadError('UPLOAD_TIMEOUT', 'upload timeout'));
    }, REQUEST_TIMEOUT_MS);
    deadline.unref();
    try {
      await publishUpload(transfer, req, res, headers.contentType, reservation, docName, roomHandle);
    } catch (err) {
      await failUpload(transfer, req, res, room, err);
    } finally {
      clearTimeout(deadline);
      releaseUpload(clientIp, reservedBytes, docName);
    }
  };

  const streamImage = (filename, clientIp, res, cacheControl, roomKey) => {
    const path = join(UPLOADS_DIR, filename);
    fs.stat(path, (err, stat) => {
      if (res.destroyed || res.writableEnded) return;
      if (err || !stat.isFile()) { res.writeHead(404); res.end(); return; }
      if (!imageReads.take(clientIp, roomKey, stat.size)) {
        res.writeHead(429, { 'retry-after': RETRY_AFTER_SHORT_SECONDS, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      const ext = filename.split('.').pop();
      res.writeHead(200, {
        'content-type': EXT_CONTENT_TYPE[ext] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': cacheControl,
        'x-content-type-options': 'nosniff',
      });
      const stream = fs.createReadStream(path);
      const abortStream = () => stream.destroy();
      res.once('close', abortStream);
      void pipeline(stream, res)
        .catch(() => { if (!res.destroyed) res.destroy(); })
        .finally(() => res.off('close', abortStream));
    });
  };

  const handleGetLegacyImage = (filename, clientIp, res) => {
    if (!LEGACY_IMAGE_FILENAME_RE.test(filename)) { res.writeHead(404); res.end(); return; }
    streamImage(filename, clientIp, res, 'public, max-age=31536000, immutable', 'legacy');
  };

  const handleGetRoomImage = (roomHandle, imageId, clientIp, res) => {
    if (!ROOM_HANDLE_RE.test(roomHandle) || !IMAGE_ID_RE.test(imageId)) {
      res.writeHead(404);
      res.end();
      return;
    }
    streamImage(`${roomHandle}.${imageId}`, clientIp, res, 'private, no-store', roomHandle);
  };

  return { handleUpload, handleGetLegacyImage, handleGetRoomImage };
};
