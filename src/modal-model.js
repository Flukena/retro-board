const PIN_PATTERN = /^[0-9]{4,8}$/;
const PIN_MAX_DIGITS = 8;
export function pinValidity(pin, confirmation, isSetting) {
  return { valid: PIN_PATTERN.test(pin), matches: !isSetting || pin === confirmation };
}

export function sanitizePin(value) { return value.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS); }

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
