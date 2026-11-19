#!/usr/bin/env node
/**
 * Two-participant live check of the board import through the real file chooser (INV-13; refactor design §7.3).
 * English admin A exports the board as ZIP, changes it, and imports the ZIP back: the canonical items of A and B equal
 * the snapshot taken before the export, the added sticky is gone, and the deleted sticky shows on A without a reload
 * (`confirmImport` must `setBoard`; the canonical Yjs read stays green without it, so the DOM assertion is its own
 * line). A JSON manifest and a CSV export import and apply. Three failures leave the board unchanged on both pages:
 * invalid JSON, an explicit invalid value (`x: null`), and a non-admin (Thai B's Import entry is disabled and a forced
 * click opens no file chooser). Cancelling the confirm dialog changes nothing.
 * Run it through the runner, which starts an isolated relay and Vite:
 * node scripts/live-check-all.mjs --only board-import-ui --out-root <fresh BaseData dir>
 * or directly: node scripts/board-import-ui-live-check.mjs <base-url> <BaseData output directory>
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  BASE_LABELS, LIVE_MODE, SYNC_TIMEOUT_MS, addSharedSticky, addZone, appLabel, boardItems, boxCenter, download, errorsStep,
  escapeRegExp, openMenu, pollUntil, runLiveCheck, sleep, step, stickyBox, waitForTextOn,
} from './board-live-helpers.mjs';

const IMP_1 = 'imp-1';
const IMP_2 = 'imp-2';
const EXTRA = 'extra';
const ZONE_TITLE = 'Imp zone';
const CSV_1 = 'csv-1';
const CSV_2 = 'csv-2';
const JSON_STICKY = 'from-json';
const ZONE_DRAG_PX = Object.freeze({ from: { x: 200, y: 200 }, to: { x: 560, y: 420 } });
// Clear of the zone (right edge 560) and of each other.
const IMP_1_ADD_PX = Object.freeze({ x: 800, y: 260 });
const IMP_2_ADD_PX = Object.freeze({ x: 800, y: 520 });
const EXTRA_ADD_PX = Object.freeze({ x: 1100, y: 360 });
const JSON_STICKY_GEOMETRY = Object.freeze({ x: 300, y: 300, w: 200, h: 180 });
const BAD_STICKY_SIZE = Object.freeze({ w: 200, h: 180 });
const MANIFEST_VERSION = 1;
const MANIFEST_BOARD_CODE = 'impcheck';
const BAD_JSON_FILE = 'bad.json';
const BAD_JSON_TEXT = 'not json';
const BAD_VALUE_FILE = 'bad-value.json';
const JSON_MANIFEST_FILE = 'from-json-manifest.json';
const BAD_VALUE_ID = 'bad-x';
const INVALID_COORDINATES_SOURCE = 'invalid coordinates';
const CHOOSER_TIMEOUT_MS = 10_000;
const DIALOG_TIMEOUT_MS = SYNC_TIMEOUT_MS;
// The local echo shows within a render; the measured resync without it is about 12 s.
const LOCAL_ECHO_TIMEOUT_MS = 3_000;
const TOAST_VISIBLE_TIMEOUT_MS = 5_000;
// The toast hides after 3200 ms (RetroBoard.jsx); the wait for it to vanish allows that plus slack.
const TOAST_HIDDEN_TIMEOUT_MS = 6_000;
// A rejected import changes the board, if it is going to, within this window; nothing may differ after it.
const UNCHANGED_WINDOW_MS = 1_500;
const NO_CHOOSER_WINDOW_MS = 1_000;
const DISABLED_TIMEOUT_MS = 5_000;
const CLOSE_MENU_KEY = 'Escape';
const JSON_INDENT_SPACES = 2;
const FILE_CHOOSER_EVENT = 'filechooser';
const SNAPSHOT_ITEM_COUNT = 3;

const STEP_NAMES = Object.freeze({
  zip: 'ZIP round trip is exact and shows on both pages',
  json: 'JSON import applies',
  csv: 'CSV import lays cards out by zone',
  badJson: 'failure 1: invalid JSON is rejected and the board is unchanged',
  badValue: 'failure 2: an explicit invalid value is rejected',
  nonAdmin: 'failure 3: a non-admin cannot import',
  cancel: 'cancelling the confirm dialog leaves the board unchanged',
});

const pickFields = ({ id, type, x, y, w, h, text, title }) => ({ id, type, x, y, w, h, text, title });
const byId = (one, other) => one.id.localeCompare(other.id);
const readNormalized = async (page) => (await boardItems(page)).map(pickFields).sort(byId);
const readBoth = (pages) => Promise.all(pages.map(readNormalized));
/** The English failure toast: its `import.fail` prefix, then optionally `detailSource` somewhere after it. */
const failToastPattern = (detailSource = '') => new RegExp(
  `^${escapeRegExp(appLabel('en', 'import.fail', { err: '' }).trimEnd())}${detailSource && `.*${detailSource}`}`,
);
const confirmDialog = (page) => page.getByRole('dialog', { name: appLabel('en', 'import.confirm.head'), exact: true });
const confirmButton = (page) => page.getByRole('button', { name: appLabel('en', 'import.confirm.ok'), exact: true });

/** Waits until every page's canonical board equals `expected`. */
const waitForBoard = (pages, expected, what) => pollUntil(
  () => readBoth(pages), (rows) => rows.every((row) => isDeepStrictEqual(row, expected)), what,
);

/** Fails when any page's board differs from `expected` once the change window has passed. */
async function assertUnchanged(pages, expected, what) {
  await sleep(UNCHANGED_WINDOW_MS);
  (await readBoth(pages)).forEach((row, index) => assert.deepStrictEqual(row, expected, `${what}: page ${index} changed`));
}

/** Opens Import on A and picks `path` in the file chooser. */
async function chooseImportFile(page, path) {
  const chooser = page.waitForEvent(FILE_CHOOSER_EVENT, { timeout: CHOOSER_TIMEOUT_MS });
  chooser.catch(() => {}); // A failed menu click is reported instead; avoid an unhandled rejection.
  await openMenu(page, 'en', appLabel('en', 'topbar.import'));
  await (await chooser).setFiles(path);
}

/** Picks `path`, confirms the overwrite dialog, and returns once the dialog has closed. */
async function importConfirmed(page, path) {
  await chooseImportFile(page, path);
  await confirmDialog(page).waitFor({ timeout: DIALOG_TIMEOUT_MS });
  await confirmButton(page).click();
  await confirmDialog(page).waitFor({ state: 'hidden', timeout: DIALOG_TIMEOUT_MS });
}

async function deleteSticky(page, text) {
  const centre = boxCenter(await stickyBox(page, text));
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.press('Delete');
}

const manifestOf = (items) => ({
  version: MANIFEST_VERSION, exportedAt: Date.now(), boardCode: MANIFEST_BOARD_CODE, board: { items },
  votes: {}, comments: {}, moods: {}, customTemplates: [],
});

async function writeCheckFile(out, name, content) {
  const path = join(out, name);
  await writeFile(path, content);
  return path;
}

async function zipRoundTrip({ a, b, report }, run) {
  await addSharedSticky(a, 'en', IMP_1, IMP_1_ADD_PX);
  await addSharedSticky(a, 'en', IMP_2, IMP_2_ADD_PX);
  await addZone(a, ZONE_TITLE, ZONE_DRAG_PX);
  await waitForTextOn([b], IMP_1);
  await waitForTextOn([b], IMP_2);
  await waitForTextOn([b], ZONE_TITLE);
  const snapshot0 = await readNormalized(a);
  assert.equal(snapshot0.length, SNAPSHOT_ITEM_COUNT, 'the board holds the zone and the two stickies before the export');
  run.zip = await download(a, 'en', appLabel('en', 'topbar.export'), report);
  await deleteSticky(a, IMP_2);
  await waitForTextOn([a, b], IMP_2, 'hidden');
  await addSharedSticky(a, 'en', EXTRA, EXTRA_ADD_PX);
  await waitForTextOn([b], EXTRA);
  await importConfirmed(a, run.zip);
  // INV-13: A's DOM shows the imported sticky at once, without a reload (the local echo of `setBoard`). Keep this
  // assertion before any reload or equality read. Without the echo the sticky only appears after a periodic resync.
  const shownAt = Date.now();
  await a.getByText(IMP_2, { exact: true }).waitFor({ state: 'visible', timeout: LOCAL_ECHO_TIMEOUT_MS });
  run.imp2ShownMs = Date.now() - shownAt;
  await waitForBoard([a, b], snapshot0, 'A and B did not return to the exported board');
  await waitForTextOn([a, b], EXTRA, 'hidden');
  run.board = snapshot0;
  return { items: snapshot0.length, imp2ShownMs: run.imp2ShownMs };
}

async function jsonImport({ a, b, report }, run) {
  const item = { id: JSON_STICKY, type: 'sticky', ...JSON_STICKY_GEOMETRY, text: JSON_STICKY };
  const content = JSON.stringify(manifestOf([item]), null, JSON_INDENT_SPACES);
  await importConfirmed(a, await writeCheckFile(report.out, JSON_MANIFEST_FILE, content));
  const expected = [pickFields(item)];
  await waitForBoard([a, b], expected, 'A and B do not show exactly the imported sticky');
  await waitForTextOn([a, b], JSON_STICKY);
  await waitForTextOn([a, b], IMP_1, 'hidden');
  run.board = expected;
  return { items: expected.length };
}

async function csvImport({ a, b, report }, run) {
  await addSharedSticky(a, 'en', CSV_1, IMP_1_ADD_PX);
  await addSharedSticky(a, 'en', CSV_2, IMP_2_ADD_PX);
  await waitForTextOn([b], CSV_1);
  await waitForTextOn([b], CSV_2);
  const csv = await download(a, 'en', appLabel('en', 'topbar.exportCsv'), report);
  await deleteSticky(a, CSV_2);
  await waitForTextOn([a, b], CSV_2, 'hidden');
  await chooseImportFile(a, csv);
  const warning = appLabel('en', 'import.csv.warning', { votes: 0, skipped: 0 });
  await confirmDialog(a).getByText(warning, { exact: true }).waitFor({ timeout: DIALOG_TIMEOUT_MS });
  await confirmButton(a).click();
  await confirmDialog(a).waitFor({ state: 'hidden', timeout: DIALOG_TIMEOUT_MS });
  // Positions are laid out again, so only the text is compared.
  await waitForTextOn([a, b], CSV_2);
  await waitForTextOn([a, b], CSV_1);
  run.board = await readNormalized(a);
  assert.deepStrictEqual(await readNormalized(b), run.board, 'A and B differ after the CSV import');
  return { items: run.board.length };
}

/** Imports `path` on A: the English failure toast shows (with `detailSource` when given), no dialog opens, the board stays. */
async function rejectedImport({ a, b }, run, path, detailSource) {
  await chooseImportFile(a, path);
  const toast = a.getByText(failToastPattern(detailSource));
  await toast.waitFor({ timeout: TOAST_VISIBLE_TIMEOUT_MS });
  assert.equal(await confirmDialog(a).count(), 0, 'a rejected file opened the confirm dialog');
  await assertUnchanged([a, b], run.board, 'a rejected import');
  await toast.waitFor({ state: 'hidden', timeout: TOAST_HIDDEN_TIMEOUT_MS });
}

async function invalidJson(context, run) {
  await rejectedImport(context, run, await writeCheckFile(context.report.out, BAD_JSON_FILE, BAD_JSON_TEXT));
}

async function invalidValue(context, run) {
  const item = { id: BAD_VALUE_ID, type: 'sticky', x: null, y: 0, ...BAD_STICKY_SIZE, text: BAD_VALUE_ID };
  const path = await writeCheckFile(context.report.out, BAD_VALUE_FILE, JSON.stringify(manifestOf([item])));
  await rejectedImport(context, run, path, INVALID_COORDINATES_SOURCE);
}

/**
 * The Import entry is a disabled button for a non-admin (`disabled={!permissions.canManage}`), so a real click never
 * reaches `onImportPick` and its admin-only toast: the check pins the disabled entry, a forced click that opens no file
 * chooser, and an unchanged board.
 */
async function nonAdminCannotImport({ a, b }, run) {
  const choosers = [];
  const onChooser = (chooser) => choosers.push(chooser);
  b.on(FILE_CHOOSER_EVENT, onChooser);
  try {
    await b.getByTitle(BASE_LABELS.th.more, { exact: true }).click();
    const entry = b.getByRole('button', { name: appLabel('th', 'topbar.import'), exact: true });
    await pollUntil(() => entry.isDisabled(), Boolean, 'the Import entry is enabled for a non-admin', DISABLED_TIMEOUT_MS);
    await entry.click({ force: true });
    await sleep(NO_CHOOSER_WINDOW_MS);
  } finally {
    b.off(FILE_CHOOSER_EVENT, onChooser);
  }
  assert.equal(choosers.length, 0, 'a file chooser opened for a non-admin');
  await b.keyboard.press(CLOSE_MENU_KEY);
  await assertUnchanged([a, b], run.board, 'a non-admin import attempt');
}

async function cancelLeavesBoard({ a, b }, run) {
  await chooseImportFile(a, run.zip);
  await confirmDialog(a).waitFor({ timeout: DIALOG_TIMEOUT_MS });
  await a.getByRole('button', { name: appLabel('en', 'common.cancel'), exact: true }).click();
  await confirmDialog(a).waitFor({ state: 'hidden', timeout: DIALOG_TIMEOUT_MS });
  await assertUnchanged([a, b], run.board, 'a cancelled import');
  await waitForTextOn([a, b], IMP_1, 'hidden');
}

await runLiveCheck('board-import-ui-live-check.mjs', async (context) => {
  const run = {};
  const { report } = context;
  await step(report, STEP_NAMES.zip, () => zipRoundTrip(context, run));
  await step(report, STEP_NAMES.json, () => jsonImport(context, run));
  await step(report, STEP_NAMES.csv, () => csvImport(context, run));
  await step(report, STEP_NAMES.badJson, () => invalidJson(context, run));
  await step(report, STEP_NAMES.badValue, () => invalidValue(context, run));
  await step(report, STEP_NAMES.nonAdmin, () => nonAdminCannotImport(context, run));
  await step(report, STEP_NAMES.cancel, () => cancelLeavesBoard(context, run));
  await errorsStep(context, LIVE_MODE.PLAIN);
});
