const PIN_PATTERN = /^[0-9]{4,8}$/;
const PIN_MAX_DIGITS = 8;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function pinValidity(pin, confirmation, isSetting) {
  return { valid: PIN_PATTERN.test(pin), matches: !isSetting || pin === confirmation };
}

export function sanitizePin(value) { return value.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS); }

export function relativeTime(timestamp, now) {
  const elapsed = now - timestamp;
  if (elapsed < MINUTE_MS) return { key: 'common.justNow', n: undefined };
  if (elapsed < HOUR_MS) return { key: 'common.minutesAgo', n: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS) return { key: 'common.hoursAgo', n: Math.floor(elapsed / HOUR_MS) };
  return { key: 'common.daysAgo', n: Math.floor(elapsed / DAY_MS) };
}

export function importWarningNotes(pendingImport) {
  const notes = [];
  if (pendingImport.sourceFormat === 'csv') {
    notes.push({ key: 'import.csv.warning', params: {
      votes: pendingImport.csvSummary?.voteCountLost ?? 0,
      skipped: pendingImport.csvSummary?.skippedRows ?? 0,
    } });
  }
  if (pendingImport.geometryRepairs?.positions > 0 || pendingImport.geometryRepairs?.zoneDimensions > 0) {
    notes.push({ key: 'import.geometry.warning', params: {
      positions: pendingImport.geometryRepairs.positions,
      zones: pendingImport.geometryRepairs.zoneDimensions,
    } });
  }
  return notes;
}
