import {
  GEOMETRY_SOURCE,
  repairBoardGeometry,
} from './board-geometry.js';
import { resolveExportBoardCode } from './export-filename.js';
import { IMPORT_MAX_FILE_BYTES, normalizeImportManifest } from './import-schema.js';
import { embedBackupImages } from './backup-images.js';

const jsonTimestamp = (timestamp) => (
  new Date(timestamp).toISOString().slice(0, 19).replace(/[:T]/g, '-')
);
const csvTimestamp = (timestamp) => (
  new Date(timestamp).toISOString().slice(0, 16).replace(/[:T]/g, '-')
);
const zoneSlug = (title) => (
  String(title || 'zone')
    .replace(/[^\w฀-๿-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'zone'
);

const entriesToRecord = (entries, valueForEntry) => {
  const record = Object.create(null);
  entries.forEach((entry) => {
    const { key, value } = valueForEntry(entry);
    (record[key] ||= []).push(value);
  });
  return record;
};

// Deep backup interface: trusted room repair, strict manifest normalization,
// room identity, safe related records, filename, and serialization happen as
// one operation. A successful artifact is guaranteed to decode immediately.
export const createJsonBackupArtifact = ({
  fallbackBoardCode,
  pathname,
  exportedAt = Date.now(),
  board,
  votes,
  comments,
  customTemplates,
}) => {
  if (!board || typeof board !== 'object' || !Array.isArray(board.items)) {
    throw new Error('missing board.items');
  }
  const geometry = repairBoardGeometry(board.items, { source: GEOMETRY_SOURCE.STORED_ROOM });
  const boardCode = resolveExportBoardCode(fallbackBoardCode, pathname);
  const rawPayload = {
    version: 1,
    exportedAt,
    boardCode,
    board: { ...board, items: geometry.items },
    votes: votes || {},
    comments: comments || {},
    customTemplates: customTemplates || [],
  };
  const normalized = normalizeImportManifest(rawPayload, exportedAt);
  const safeVotes = entriesToRecord(normalized.voteEntries, (entry) => ({
    key: entry.itemId,
    value: entry.userId,
  }));
  const safeComments = entriesToRecord(normalized.commentEntries, (entry) => ({
    key: entry.itemId,
    value: entry.comment,
  }));
  const payload = {
    ...rawPayload,
    board: { ...rawPayload.board, items: normalized.items },
    votes: safeVotes,
    comments: safeComments,
    customTemplates: normalized.customTemplates,
  };
  return {
    fileName: `retro-${boardCode}-${jsonTimestamp(exportedAt)}.json`,
    mimeType: 'application/json',
    contents: JSON.stringify(payload, null, 2),
    payload,
    geometryRepairs: geometry.repairs,
  };
};

export async function createPortableJsonBackupArtifact(options, readImage) {
  const artifact = createJsonBackupArtifact(options);
  const remainingBytes = IMPORT_MAX_FILE_BYTES - new TextEncoder().encode(artifact.contents).byteLength;
  if (remainingBytes < 0) throw new Error(`backup exceeds ${IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB`);
  const items = await embedBackupImages(artifact.payload.board.items, readImage, remainingBytes);
  const payload = { ...artifact.payload, board: { ...artifact.payload.board, items } };
  const contents = JSON.stringify(payload, null, 2);
  if (new TextEncoder().encode(contents).byteLength > IMPORT_MAX_FILE_BYTES) {
    throw new Error(`backup exceeds ${IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB`);
  }
  return { ...artifact, payload, contents };
}

export const createCsvExportArtifact = ({
  csv,
  fallbackBoardCode,
  pathname,
  zoneTitle,
  exportedAt = Date.now(),
}) => {
  const boardCode = resolveExportBoardCode(fallbackBoardCode, pathname);
  const zonePart = zoneTitle == null ? '' : `-${zoneSlug(zoneTitle)}`;
  return {
    fileName: `retro-${boardCode}${zonePart}-${csvTimestamp(exportedAt)}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    contents: String(csv ?? ''),
  };
};
