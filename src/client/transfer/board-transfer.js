import { DEFAULT_BOARD } from '../../domain/board-state.js';
import { IMPORT_MAX_ARCHIVE_FILE_BYTES, IMPORT_MAX_CSV_FILE_BYTES, IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_BUNDLE_BYTES, importBundleByteLength, normalizeImportManifest } from '../../domain/import-schema.js';
import { parseBoardCsv } from '../../domain/csv-import.js';
import { createCsvExportArtifact, buildZoneCsv, buildBoardCsv } from './board-backup.js';
import { redactBoardExportForViewer } from '../../domain/security-boundaries.js';
import { isStickyHiddenForUser } from '../../domain/board-visibility.js';
import { readBackupImage, sanitizeImportedImages } from './image-upload.js';
import { csvLabels } from './csv-labels.js';

const BYTES_PER_MIB = 1024 * 1024;
const loadArchive = () => import('./board-archive.js');
const IMPORT_FILE_LIMITS = { zip: IMPORT_MAX_ARCHIVE_FILE_BYTES, csv: IMPORT_MAX_CSV_FILE_BYTES, json: IMPORT_MAX_FILE_BYTES };

export class ImportBundleLimitError extends Error {
  constructor() {
    super('import bundle exceeds room limit');
    this.maximumMiB = (IMPORT_MAX_BUNDLE_BYTES / BYTES_PER_MIB).toFixed(1);
  }
}

function snapshotEntries(snapshot) {
  const entries = Object.create(null);
  snapshot.forEach((values, id) => { entries[id] = values instanceof Set ? Array.from(values) : values; });
  return entries;
}

export async function createBoardExport(board, { boardCode, userId }) {
  const votes = snapshotEntries(window.storage?.snapshotVotes?.() || new Map());
  const comments = snapshotEntries(window.storage?.snapshotComments?.() || new Map());
  const redacted = redactBoardExportForViewer(board.items, comments,
    sticky => isStickyHiddenForUser(sticky, board.items, board.allRevealed, userId));
  return (await loadArchive()).createBoardArchiveArtifact({
    fallbackBoardCode: boardCode,
    board: { items: redacted.items, timer: board.timer, editingLocked: board.editingLocked,
      votingLocked: board.votingLocked, allRevealed: board.allRevealed, lastResultsAt: board.lastResultsAt },
    votes, comments: redacted.comments, customTemplates: window.storage?.snapshotTemplates?.() || [],
  }, readBackupImage);
}

export function createCsvBoardExport(board, { boardCode, userId, zone = null }) {
  const votes = window.storage?.snapshotVotes?.() || new Map();
  const csv = zone ? buildZoneCsv(zone, board, votes, userId, csvLabels()) : buildBoardCsv(board, votes, userId, csvLabels());
  return createCsvExportArtifact({ csv, fallbackBoardCode: boardCode, zoneTitle: zone?.title });
}

function importFormat(file) {
  const csv = file.name.toLowerCase().endsWith('.csv') || /text\/csv/i.test(file.type);
  const archive = file.name.toLowerCase().endsWith('.zip') || /application\/zip/i.test(file.type);
  return { csv, archive, name: archive ? 'zip' : csv ? 'csv' : 'json' };
}

export async function readBoardImport(file, importedAt = Date.now()) {
  const format = importFormat(file);
  const maxBytes = IMPORT_FILE_LIMITS[format.name];
  if (file.size > maxBytes) throw new Error(`file exceeds ${(maxBytes / BYTES_PER_MIB).toFixed(0)} MB`);
  const text = format.archive ? null : await file.text();
  const csv = format.csv ? parseBoardCsv(text, importedAt) : null;
  const manifest = format.archive ? await (await loadArchive()).readBoardArchive(file, importedAt)
    : normalizeImportManifest(csv ? csv.payload : JSON.parse(text), importedAt);
  return { name: file.name, ...manifest, sourceFormat: format.name, csvSummary: csv?.summary ?? null };
}

export async function prepareBoardImport(manifest, currentBoard) {
  const items = manifest.items.map(item => item.type === 'zone'
    ? { ...item, voteTimer: null, lastResultsAt: null, voteResults: null, votingLocked: false } : item);
  const importedItems = await sanitizeImportedImages(items, manifest.readImageBlob);
  const meta = manifest.boardMeta;
  const nextBoard = { ...DEFAULT_BOARD, items: importedItems, timer: meta.timer,
    editingLocked: meta.editingLocked, votingLocked: meta.votingLocked,
    allRevealed: meta.allRevealed, lastResultsAt: meta.lastResultsAt,
    title: meta.title ?? currentBoard.title ?? null,
    adminUserId: currentBoard.adminUserId, adminName: currentBoard.adminName, adminPinHash: currentBoard.adminPinHash };
  const snapshotBytes = importBundleByteLength({ board: nextBoard, votes: manifest.voteEntries,
    comments: manifest.commentEntries, customTemplates: manifest.customTemplates });
  if (snapshotBytes > IMPORT_MAX_BUNDLE_BYTES) throw new ImportBundleLimitError();
  return nextBoard;
}
