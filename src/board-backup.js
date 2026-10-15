import { effectiveOwnerZone } from './board-ownership.js';
import { isStickyHiddenForUser } from './board-visibility.js';

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

const csvColorName = (i) => CSV_COLOR_NAMES[i] || String(i);
const csvEsc = (v) => {
  let s = v == null ? '' : String(v);
  if (CSV_FORMULA_PREFIX_PATTERN.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};


const CSV_FORMULA_PREFIX_PATTERN = /^\s*[=+\-@\t\r]/;
const CSV_BOM = '\uFEFF';
const CSV_ROW_SEPARATOR = '\r\n';
const CSV_COLUMN_SEPARATOR = ',';
const CSV_COLOR_NAMES = ['yellow', 'red', 'green', 'blue', 'purple', 'orange'];
const CSV_STICKY_COLUMNS = ['text', 'author', 'votes', 'color', 'createdAt'];

const csvHeader = (labels, columns = CSV_STICKY_COLUMNS) => (
  columns.map((key) => csvEsc(labels[key])).join(CSV_COLUMN_SEPARATOR)
);
const csvStickyRow = (sticky, board, votes, userId, labels) => [
  isStickyHiddenForUser(sticky, board.items, board.allRevealed, userId)
    ? labels.hidden : (sticky.text || ''),
  sticky.authorName || '',
  votes.get(sticky.id)?.size ?? 0,
  csvColorName(sticky.color ?? 0),
  sticky.createdAt ? new Date(sticky.createdAt).toISOString() : '',
];
const sortByVotes = (items, votes) => items.sort((a, b) => (
  (votes.get(b.id)?.size ?? 0) - (votes.get(a.id)?.size ?? 0)
));
const joinCsv = (lines) => CSV_BOM + lines.join(CSV_ROW_SEPARATOR);

export const buildZoneCsv = (zone, board, votes, userId, labels) => {
  const children = board.items.filter((item) => (
    item.type === 'sticky' && effectiveOwnerZone(item, board.items)?.id === zone.id
  ));
  const lines = [csvHeader(labels)];
  sortByVotes(children, votes).forEach((sticky) => {
    lines.push(csvStickyRow(sticky, board, votes, userId, labels).map(csvEsc).join(CSV_COLUMN_SEPARATOR));
  });
  return joinCsv(lines);
};

export const buildBoardCsv = (board, votes, userId, labels) => {
  const zones = board.items.filter((item) => item.type === 'zone');
  const stickies = board.items.filter((item) => item.type === 'sticky');
  const ownerByStickyId = new Map();
  stickies.forEach((sticky) => {
    const owner = effectiveOwnerZone(sticky, board.items);
    if (owner) ownerByStickyId.set(sticky.id, owner.id);
  });
  const lines = [csvHeader(labels, ['zone', ...CSV_STICKY_COLUMNS])];
  const pushRow = (zoneLabel, sticky) => {
    lines.push([zoneLabel, ...csvStickyRow(sticky, board, votes, userId, labels)]
      .map(csvEsc).join(CSV_COLUMN_SEPARATOR));
  };
  zones.forEach((zone) => {
    sortByVotes(stickies.filter((sticky) => ownerByStickyId.get(sticky.id) === zone.id), votes)
      .forEach((sticky) => pushRow(zone.title || labels.untitledZone, sticky));
  });
  sortByVotes(stickies.filter((sticky) => !ownerByStickyId.has(sticky.id)), votes)
    .forEach((sticky) => pushRow(labels.unassigned, sticky));
  return joinCsv(lines);
};
