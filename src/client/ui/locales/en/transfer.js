export const transfer = {
    'export.image.reduced': 'Downloaded {file} (scaled down to fit the browser limit)',
    'export.image.missing': 'Downloaded {file}; {n} images could not be included',
    'export.image.empty': 'The board is empty — nothing to export',
};

export const transfer2 = {
    'export.csv.zone': 'Zone',
    'export.csv.text': 'Text',
    'export.csv.author': 'Author',
    'export.csv.votes': 'Votes',
    'export.csv.color': 'Color',
    'export.csv.createdAt': 'Created at',
    'export.csv.unassigned': '(no zone)',
    'export.csv.untitledZone': '(untitled zone)',
    'export.csv.hidden': '[hidden]',
};

export const transfer3 = {
    'export.done': 'Downloaded {file}',
    'export.repaired': 'Downloaded {file} (repositioned {positions} item(s); defaulted {zones} zone size(s))',
    'export.flattened': 'Downloaded {file} — {count} animated or oversized image(s) were saved as still images ({ids})',
    'export.processing': 'Preparing backup and images…',
    'export.fail': 'Could not create a re-importable backup — {err}',
    'import.confirm.head': 'Load board from file?',
    'import.confirm.body': 'This overwrites the current board — {n} items from "{file}"',
    'import.csv.warning': 'CSV cards will be laid out again by zone. {votes} vote(s), comments, and original positions cannot be restored; {skipped} row(s) will be skipped.',
    'import.geometry.warning': 'Geometry was missing: {positions} item(s) were repositioned and {zones} zone size(s) defaulted; original positions cannot be recovered.',
    'import.confirm.ok': 'Overwrite',
    'import.done': 'Imported {n} items',
    'import.doneWithSkipped': 'Imported {n} items ({skipped} image(s) skipped — could not be processed)',
    'import.processing': 'Processing images… this may take a moment',
    'import.tooLarge': 'Import is still too large even after processing images (over {mb} MB) — try reducing image size or item count in the source file first',
    'import.fail': 'Invalid file — {err}',
};

export const transfer4 = {
    'transfer.list.title': 'online users',
    'transfer.list.empty': 'No other users',
    'transfer.done': 'Admin transferred',
    'transfer.becomeAdmin': '👑 You\'re now the admin — you can lock editing and run votes',
};
