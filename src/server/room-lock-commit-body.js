import { BLOB_ID_PATTERN, hasExactKeys, isCounter, parseAuthKey, parseLockParams } from '../domain/room-lock-contract.js';

export const MAX_COMMIT_HEADER_BYTES = 1024 * 1024;
export const MAX_KEEP_BLOBS = 10_000;
export const HEADER_LENGTH_BYTES = 4;
const COMMIT_KEYS = ['oldAuthKey', 'rotationId', 'expectedHead', 'keyEpoch', 'lock', 'keepBlobs'];
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_LARGE = 413;

const refusal = (status) => Object.assign(new Error('commit body refused'), { status });
export const isBlobId = (value) => typeof value === 'string' && BLOB_ID_PATTERN.test(value);

const parseKeepBlobs = (value) => {
  const unique = Array.isArray(value) && value.length <= MAX_KEEP_BLOBS && new Set(value).size === value.length;
  if (!unique || !value.every(isBlobId)) throw refusal(HTTP_BAD_REQUEST);
  return value;
};

/** Validates the JSON header of a rotation commit (Deviation 5). */
export function parseCommitHeader(jsonBytes) {
  let header;
  try { header = JSON.parse(jsonBytes.toString('utf8')); } catch { throw refusal(HTTP_BAD_REQUEST); }
  if (!header || typeof header !== 'object' || Array.isArray(header) || !hasExactKeys(header, COMMIT_KEYS)) throw refusal(HTTP_BAD_REQUEST);
  const lock = parseLockParams(header.lock);
  const valid = parseAuthKey(header.oldAuthKey) && lock && isBlobId(header.rotationId)
    && isCounter(header.expectedHead) && isCounter(header.keyEpoch);
  if (!valid) throw refusal(HTTP_BAD_REQUEST);
  return { ...header, lock, keepBlobs: parseKeepBlobs(header.keepBlobs) };
}

// The header once `head` holds the length prefix and the whole header, else null; a bad length throws at once.
function splitHead(head) {
  if (head.length < HEADER_LENGTH_BYTES) return null;
  const headerLength = head.readUInt32BE(0);
  if (headerLength > MAX_COMMIT_HEADER_BYTES) throw refusal(HTTP_TOO_LARGE);
  const snapshotAt = HEADER_LENGTH_BYTES + headerLength;
  if (head.length < snapshotAt) return null;
  return { header: parseCommitHeader(head.subarray(HEADER_LENGTH_BYTES, snapshotAt)), rest: head.subarray(snapshotAt) };
}

/**
 * Reads `[u32 BE header length][JSON header][snapshot]` from the request as it arrives. A bad header length, a bad
 * header or an oversized snapshot rejects at once with `{ status }`, without waiting for the rest of the body.
 * Resolves `{ header, snapshot }`.
 */
export function readCommitBody(req, maxSnapshotBytes) {
  const declared = req.headers['content-length'];
  const maxTotal = HEADER_LENGTH_BYTES + MAX_COMMIT_HEADER_BYTES + maxSnapshotBytes;
  if (declared != null && (!/^\d+$/.test(String(declared)) || Number(declared) > maxTotal)) return Promise.reject(refusal(HTTP_TOO_LARGE));
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    let header = null;
    let snapshotBytes = 0;
    const snapshotChunks = [];
    const stop = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', fail); };
    const fail = (error) => { stop(); req.pause(); reject(error); };
    const addSnapshot = (chunk) => {
      snapshotBytes += chunk.length;
      if (snapshotBytes > maxSnapshotBytes) throw refusal(HTTP_TOO_LARGE);
      if (chunk.length > 0) snapshotChunks.push(chunk);
    };
    function onData(chunk) {
      try {
        if (header) { addSnapshot(chunk); return; }
        head = Buffer.concat([head, chunk]);
        const split = splitHead(head);
        if (!split) return;
        ({ header } = split);
        head = null;
        addSnapshot(split.rest);
      } catch (error) { fail(error); }
    }
    function onEnd() {
      stop();
      if (!header) reject(refusal(HTTP_BAD_REQUEST));
      else if (snapshotBytes === 0) reject(refusal(HTTP_TOO_LARGE));
      else resolve({ header, snapshot: new Uint8Array(Buffer.concat(snapshotChunks)) });
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', fail);
  });
}
