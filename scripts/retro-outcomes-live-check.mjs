#!/usr/bin/env node
/**
 * Two-participant live check for board exports, retired commands and legacy sticky data.
 * Start isolated servers first (see ui-live-check.mjs for the env; pick free ports), then:
 * node scripts/retro-outcomes-live-check.mjs <base-url> <BaseData output directory>
 * A (English) and B (Thai) share one new board. Writes screenshots, downloads and report.json.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BASE_LABELS, REDO_KEY, SYNC_TIMEOUT_MS, addSharedSticky, addSticky, addZone, appLabel, boardItems, download,
  openMenu, pollUntil, runLiveCheck, step, undoUntilHidden, waitForTextOn,
} from './board-live-helpers.mjs';

const STICKY_POSITION_PX = { x: 520, y: 380 };
const PRIVATE_POSITION_PX = { x: 900, y: 380 };
const SHARED_TEXT = 'Fix flaky CI';
const SECRET_TEXT = 'Secret salary idea';
const LEGACY_FIELDS = { actionItem: true, actionOwner: 'Nok', actionDue: '2026-11-30', actionDone: true };
const ZONE_TITLE = 'ไปได้ดี';
const THAI_TEXT = 'ทีมช่วยกันรีวิวโค้ดเร็วขึ้นมากในสปรินต์นี้ ขอบคุณทุกคน';
const ZONE_DRAG_PX = { from: { x: 260, y: 600 }, to: { x: 1200, y: 880 } };
const ZONE_STICKY_PX = { x: 560, y: 720 };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const RETIRED_LABELS = {
  en: ['Action items', 'Copy retro summary', 'Download summary (.md)'],
  th: ['Action items', 'คัดลอกสรุป retro', 'ดาวน์โหลดสรุป (.md)'],
};

async function checkMenu(page, lang) {
  await page.getByTitle(BASE_LABELS[lang].more, { exact: true }).click();
  const menu = page.locator('.rb-topbar-popover--more');
  await menu.getByRole('button', { name: appLabel(lang, 'topbar.exportCsv'), exact: true }).waitFor();
  for (const name of RETIRED_LABELS[lang]) assert.equal(await menu.getByRole('button', { name, exact: true }).count(), 0);
  await page.keyboard.press('Escape');
}

await runLiveCheck('retro-outcomes-live-check.mjs', async ({ a, b, report }) => {
  await step(report, 'Both languages offer board exports without action items or Markdown summaries', async () => {
    await Promise.all([checkMenu(a, 'en'), checkMenu(b, 'th')]);
  });
  await step(report, 'A shares a sticky and both peers see undo and redo', async () => {
    await addSharedSticky(a, 'en', SHARED_TEXT, STICKY_POSITION_PX);
    await waitForTextOn([a, b], SHARED_TEXT);
    await a.locator('.rb-selection-toolbar').waitFor();
    assert.equal(await a.getByTitle('Mark as action item', { exact: true }).count(), 0);
    const presses = await undoUntilHidden(a, SHARED_TEXT);
    await waitForTextOn([a, b], SHARED_TEXT, 'hidden');
    for (let count = 0; count < presses; count++) await a.keyboard.press(REDO_KEY);
    await waitForTextOn([a, b], SHARED_TEXT);
  });
  await step(report, 'B adds a private card that A cannot read', async () => {
    // New cards start private, so B's card stays hidden from A.
    await addSticky(b, 'th', SECRET_TEXT, PRIVATE_POSITION_PX);
    await b.keyboard.press('Escape');
    await a.getByText(SECRET_TEXT, { exact: true }).waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS });
  });
  await step(report, 'B reveals their note and A sees the edit', async () => {
    await b.getByText(SECRET_TEXT, { exact: true }).click();
    await b.getByTitle(BASE_LABELS.th.reveal, { exact: true }).click();
    await waitForTextOn([a, b], SECRET_TEXT);
  });
  await step(report, 'A adds a Thai zone with a Thai sticky for the image export', async () => {
    await addZone(a, ZONE_TITLE, ZONE_DRAG_PX);
    await addSticky(a, 'en', THAI_TEXT, ZONE_STICKY_PX);
    await a.getByTitle(BASE_LABELS.en.reveal, { exact: true }).click();
    await a.keyboard.press('Escape');
    await b.getByText(THAI_TEXT, { exact: true }).waitFor({ timeout: SYNC_TIMEOUT_MS });
  });
  await step(report, 'A exports PNG and PDF', async () => {
    const png = await readFile(await download(a, 'en', appLabel('en', 'topbar.exportPng'), report));
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
    const pdf = await readFile(await download(a, 'en', appLabel('en', 'topbar.exportPdf'), report));
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
    return { pngWidth: png.readUInt32BE(PNG_WIDTH_OFFSET), pngHeight: png.readUInt32BE(PNG_HEIGHT_OFFSET), pdfBytes: pdf.length };
  });
  await step(report, 'B downloads the board CSV from the Thai menu', async () => {
    const file = await download(b, 'th', appLabel('th', 'topbar.exportCsv'), report);
    const contents = await readFile(file, 'utf8');
    for (const text of [SHARED_TEXT, THAI_TEXT]) assert.ok(contents.includes(text));
  });
  await step(report, 'A legacy sticky round-trips through ZIP as an ordinary card', async () => {
    const { id } = (await boardItems(a)).find(item => item.text === SHARED_TEXT);
    // A peer running an older client can still write these fields to the shared note.
    const setFields = fields => b.evaluate(({ id, fields }) => window.storage.updateItem(id, fields), { id, fields });
    await setFields(LEGACY_FIELDS);
    const readFields = async page => {
      const item = (await boardItems(page)).find(card => card.id === id);
      return Object.fromEntries(Object.keys(LEGACY_FIELDS).map(key => [key, item?.[key]]));
    };
    const restored = value => Object.entries(LEGACY_FIELDS).every(([key, field]) => value[key] === field);
    await pollUntil(() => readFields(a), restored, 'Exporting peer receives legacy fields');
    const zip = await download(a, 'en', appLabel('en', 'topbar.export'), report);
    await setFields({ actionDone: false });
    await pollUntil(() => readFields(a), fields => fields.actionDone === false, 'Importing peer sees the change before restore');
    const chooser = a.waitForEvent('filechooser');
    await openMenu(a, 'en', appLabel('en', 'topbar.import'));
    await (await chooser).setFiles(zip);
    await a.getByRole('button', { name: appLabel('en', 'import.confirm.ok'), exact: true }).click();
    for (const page of [a, b]) {
      await pollUntil(() => readFields(page), restored, 'ZIP restores the historical fields');
      await page.getByText(SHARED_TEXT, { exact: true }).waitFor();
      assert.equal(await page.locator('.rb-action-badge').count(), 0);
    }
  });
});
