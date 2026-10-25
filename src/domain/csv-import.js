import { COMMENT_AUTHOR_NAME_MAX_LEN } from './comment-schema.js';
import {
  IMPORT_MAX_CSV_FILE_BYTES,
  IMPORT_MAX_ITEMS,
} from './import-schema.js';
import {
  BOARD_TEXT_MAX_LENGTH,
  ZONE_TITLE_MAX_LENGTH,
} from './security-boundaries.js';

const STICKY_WIDTH = 200;
const STICKY_HEIGHT = 180;
const STICKY_GAP = 30;
const STICKY_COLUMNS = 4;
const ZONE_WIDTH = 1140;
const ZONE_MIN_HEIGHT = 600;
const ZONE_HEADER_HEIGHT = 80;
const ZONE_GAP = 60;
const ZONE_COLUMNS = 4;

const COLUMN_ALIASES = {
  zone: new Set(['zone', 'โซน']),
  text: new Set(['text', 'ข้อความ', 'เนื้อหา']),
  author: new Set(['author', 'ผู้เขียน', 'ผู้สร้าง']),
  votes: new Set(['votes', 'vote', 'โหวต', 'คะแนนโหวต', 'จำนวนโหวต']),
  color: new Set(['color', 'colour', 'สี']),
  createdAt: new Set([
    'created at',
    'createdat',
    'created_at',
    'สร้างเมื่อ',
    'วันที่สร้าง',
    'เวลาที่สร้าง',
  ]),
};

const COLUMN_KEYS = Object.keys(COLUMN_ALIASES);
const UNASSIGNED_ZONE_LABELS = new Set([
  '',
  '(no zone)',
  'no zone',
  '(ไม่มีโซน)',
  'ไม่มีโซน',
]);
const UNTITLED_ZONE_LABELS = new Set([
  '(untitled zone)',
  'untitled zone',
  '(โซนไม่มีชื่อ)',
  'โซนไม่มีชื่อ',
]);
const COLOR_INDEX = new Map([
  ['yellow', 0], ['เหลือง', 0],
  ['red', 1], ['แดง', 1],
  ['green', 2], ['เขียว', 2],
  ['blue', 3], ['น้ำเงิน', 3], ['ฟ้า', 3],
  ['purple', 4], ['ม่วง', 4],
  ['orange', 5], ['ส้ม', 5],
]);

const normalizeHeader = (value) => String(value ?? '').trim().toLocaleLowerCase('en-US');
const decodeExportEscapedValue = (value) => (
  /^'(?=[\s]*[=+\-@\t\r])/.test(value) ? value.slice(1) : value
);
const isBlankRow = (fields) => fields.every((field) => field.trim() === '');
const boundedTimestamp = (value, fallback) => {
  if (!value.trim()) return fallback;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const parseCsvRows = (source) => {
  if (typeof source !== 'string') throw new Error('CSV content must be a string');
  if (new TextEncoder().encode(source).byteLength > IMPORT_MAX_CSV_FILE_BYTES) {
    throw new Error(`CSV file exceeds ${IMPORT_MAX_CSV_FILE_BYTES} bytes`);
  }
  const input = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const rows = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let line = 1;
  let rowLine = 1;

  const endField = () => {
    fields.push(field);
    field = '';
    afterQuote = false;
  };
  const endRow = () => {
    endField();
    rows.push({ fields, line: rowLine });
    if (rows.length > IMPORT_MAX_ITEMS + 1) {
      throw new Error(`CSV has too many rows (max ${IMPORT_MAX_ITEMS})`);
    }
    fields = [];
    rowLine = line + 1;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += char;
        if (char === '\n') line += 1;
        else if (char === '\r' && input[index + 1] !== '\n') line += 1;
      }
      continue;
    }

    if (afterQuote && char !== ',' && char !== '\r' && char !== '\n') {
      throw new Error(`unexpected character after closing quote on line ${line}`);
    }
    if (char === '"') {
      if (field.length > 0) throw new Error(`unexpected quote on line ${line}`);
      inQuotes = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      endRow();
      line += 1;
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new Error(`unclosed quoted field starting on line ${rowLine}`);
  if (field.length > 0 || fields.length > 0 || afterQuote) {
    endRow();
  }
  return rows;
};

const readHeader = (header) => {
  const indexes = {};
  const unknown = [];
  header.fields.forEach((label, index) => {
    const normalized = normalizeHeader(label);
    const key = COLUMN_KEYS.find((candidate) => COLUMN_ALIASES[candidate].has(normalized));
    if (!key) {
      if (normalized) unknown.push(label.trim());
      return;
    }
    if (indexes[key] != null) throw new Error(`duplicate CSV column: ${label.trim()}`);
    indexes[key] = index;
  });
  const missing = COLUMN_KEYS.filter((key) => indexes[key] == null);
  if (missing.length > 0) throw new Error(`missing CSV columns: ${missing.join(', ')}`);
  return { indexes, unknown };
};

const parseColor = (value) => {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (COLOR_INDEX.has(normalized)) return COLOR_INDEX.get(normalized);
  if (/^[0-5]$/.test(normalized)) return Number(normalized);
  return null;
};

const zoneHeightFor = (stickyCount) => {
  const rows = Math.max(1, Math.ceil(stickyCount / STICKY_COLUMNS));
  return Math.max(
    ZONE_MIN_HEIGHT,
    ZONE_HEADER_HEIGHT + (rows * STICKY_HEIGHT) + ((rows + 1) * STICKY_GAP),
  );
};

const assignZonePositions = (groups) => {
  let y = 0;
  for (let start = 0; start < groups.length; start += ZONE_COLUMNS) {
    const row = groups.slice(start, start + ZONE_COLUMNS);
    const rowHeight = Math.max(...row.map((group) => group.height));
    row.forEach((group, column) => {
      group.x = column * (ZONE_WIDTH + ZONE_GAP);
      group.y = y;
    });
    y += rowHeight + ZONE_GAP;
  }
  return y;
};

const issue = (row, code, message) => ({ row, code, message });

// Convert the exact whole-room CSV shape emitted by RetroBoard into the same
// normalized manifest used by JSON imports. CSV has no durable IDs, geometry,
// voter identities, comments, or empty zones, so those parts are rebuilt or
// deliberately left empty here.
export const parseBoardCsv = (source, importedAt = Date.now()) => {
  const safeImportedAt = Number.isSafeInteger(importedAt)
    && importedAt >= 0
    && importedAt <= Number.MAX_SAFE_INTEGER - IMPORT_MAX_ITEMS
    ? importedAt
    : Date.now();
  const parsedRows = parseCsvRows(source);
  const headerIndex = parsedRows.findIndex((row) => !isBlankRow(row.fields));
  if (headerIndex < 0) throw new Error('CSV file is empty');

  const { indexes, unknown } = readHeader(parsedRows[headerIndex]);
  const issues = unknown.length > 0
    ? [issue(parsedRows[headerIndex].line, 'unknown-columns', `ignored columns: ${unknown.join(', ')}`)]
    : [];
  const records = [];
  const zoneKeys = new Set();
  let skippedRowCount = 0;
  let omittedVoteCount = 0;

  parsedRows.slice(headerIndex + 1).forEach((row) => {
    if (isBlankRow(row.fields)) return;
    if (indexes.zone >= row.fields.length || indexes.text >= row.fields.length) {
      skippedRowCount += 1;
      issues.push(issue(row.line, 'missing-required-field', 'row has no zone or text field'));
      return;
    }

    const get = (key) => decodeExportEscapedValue(row.fields[indexes[key]] ?? '');
    const originalZone = get('zone').trim();
    const unassigned = UNASSIGNED_ZONE_LABELS.has(normalizeHeader(originalZone));
    const untitled = UNTITLED_ZONE_LABELS.has(normalizeHeader(originalZone));
    const createsZone = !unassigned && !zoneKeys.has(originalZone);
    if (records.length + 1 + zoneKeys.size + (createsZone ? 1 : 0) > IMPORT_MAX_ITEMS) {
      skippedRowCount += 1;
      issues.push(issue(row.line, 'item-limit', `row skipped to keep import within ${IMPORT_MAX_ITEMS} items`));
      return;
    }
    if (createsZone) zoneKeys.add(originalZone);
    const rawText = get('text');
    const hiddenText = rawText === '[hidden]' || rawText === '[ซ่อน]';
    const rawAuthor = get('author');
    const rawColor = get('color');
    const rawCreatedAt = get('createdAt');
    const rawVotes = get('votes').trim();

    let text = hiddenText ? '' : rawText;
    if (text.length > BOARD_TEXT_MAX_LENGTH) {
      text = text.slice(0, BOARD_TEXT_MAX_LENGTH);
      issues.push(issue(row.line, 'text-truncated', `text truncated to ${BOARD_TEXT_MAX_LENGTH} characters`));
    }
    let authorName = rawAuthor;
    if (authorName.length > COMMENT_AUTHOR_NAME_MAX_LEN) {
      authorName = authorName.slice(0, COMMENT_AUTHOR_NAME_MAX_LEN);
      issues.push(issue(
        row.line,
        'author-truncated',
        `author truncated to ${COMMENT_AUTHOR_NAME_MAX_LEN} characters`,
      ));
    }
    const color = parseColor(rawColor);
    if (color == null && rawColor.trim()) {
      issues.push(issue(row.line, 'invalid-color', `unknown color "${rawColor.trim()}"; used yellow`));
    }
    const createdAt = boundedTimestamp(rawCreatedAt, safeImportedAt + records.length);
    if (createdAt == null) {
      issues.push(issue(row.line, 'invalid-created-at', 'invalid creation date; used import time'));
    }
    if (rawVotes) {
      const votes = Number(rawVotes);
      if (!Number.isSafeInteger(votes) || votes < 0) {
        issues.push(issue(row.line, 'invalid-votes', `invalid vote count "${rawVotes}"; ignored`));
      } else {
        omittedVoteCount = Math.min(Number.MAX_SAFE_INTEGER, omittedVoteCount + votes);
      }
    }
    if (hiddenText) {
      issues.push(issue(row.line, 'hidden-text-unavailable', 'hidden card text was not present in the CSV'));
    }

    let zoneTitle = untitled || unassigned ? '' : originalZone;
    if (zoneTitle.length > ZONE_TITLE_MAX_LENGTH) {
      zoneTitle = zoneTitle.slice(0, ZONE_TITLE_MAX_LENGTH);
      issues.push(issue(
        row.line,
        'zone-title-truncated',
        `zone title truncated to ${ZONE_TITLE_MAX_LENGTH} characters`,
      ));
    }
    records.push({
      row: row.line,
      zoneKey: unassigned ? null : originalZone,
      zoneTitle,
      text,
      private: hiddenText,
      authorName,
      color: color ?? 0,
      createdAt: createdAt ?? (safeImportedAt + records.length),
    });
  });

  if (omittedVoteCount > 0) {
    issues.push(issue(
      null,
      'votes-not-imported',
      `${omittedVoteCount} vote(s) were not imported because CSV does not contain voter IDs`,
    ));
  }

  const groupByKey = new Map();
  records.forEach((record) => {
    if (record.zoneKey == null) return;
    if (!groupByKey.has(record.zoneKey)) {
      groupByKey.set(record.zoneKey, { key: record.zoneKey, title: record.zoneTitle, records: [] });
    }
    const group = groupByKey.get(record.zoneKey);
    record.zonePosition = group.records.length;
    group.records.push(record);
  });
  const groups = [...groupByKey.values()];
  groups.forEach((group) => { group.height = zoneHeightFor(group.records.length); });
  const unassignedStartY = assignZonePositions(groups);
  const idSeed = safeImportedAt.toString(36);
  const zoneIdByKey = new Map();
  const items = groups.map((group, index) => {
    const id = `csv-zone-${idSeed}-${index}`;
    zoneIdByKey.set(group.key, id);
    return {
      id,
      type: 'zone',
      x: group.x,
      y: group.y,
      w: ZONE_WIDTH,
      h: group.height,
      title: group.title,
      color: 0,
      authorId: '',
      authorName: '',
      createdAt: safeImportedAt + index,
      zIndex: index,
      locked: false,
      revealed: true,
    };
  });

  let unassignedIndex = 0;
  records.forEach((record, index) => {
    const group = record.zoneKey == null ? null : groupByKey.get(record.zoneKey);
    const position = group ? record.zonePosition : unassignedIndex;
    if (!group) unassignedIndex += 1;
    const column = position % STICKY_COLUMNS;
    const row = Math.floor(position / STICKY_COLUMNS);
    const x = group
      ? group.x + STICKY_GAP + (column * (STICKY_WIDTH + STICKY_GAP))
      : column * (STICKY_WIDTH + STICKY_GAP);
    const y = group
      ? group.y + ZONE_HEADER_HEIGHT + STICKY_GAP + (row * (STICKY_HEIGHT + STICKY_GAP))
      : unassignedStartY + STICKY_GAP + (row * (STICKY_HEIGHT + STICKY_GAP));
    items.push({
      id: `csv-sticky-${idSeed}-${index}`,
      type: 'sticky',
      x,
      y,
      w: STICKY_WIDTH,
      h: STICKY_HEIGHT,
      parentZoneId: record.zoneKey == null ? null : zoneIdByKey.get(record.zoneKey),
      text: record.text,
      private: record.private,
      color: record.color,
      authorId: '',
      authorName: record.authorName,
      createdAt: record.createdAt,
      zIndex: groups.length + index,
    });
  });

  const payload = {
    board: {
      items,
      editingLocked: false,
      votingLocked: false,
      allRevealed: false,
      lastResultsAt: null,
    },
    votes: {},
    comments: {},
    customTemplates: null,
  };

  return {
    payload,
    summary: {
      importedRows: records.length,
      skippedRows: skippedRowCount,
      zoneCount: groups.length,
      voteCountLost: omittedVoteCount,
      issues,
    },
  };
};
