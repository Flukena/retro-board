#!/usr/bin/env node
/**
 * Two-participant live check for action items, the retro summary and PNG/PDF/ZIP export.
 * Start isolated servers first (see ui-live-check.mjs for the env; pick free ports), then:
 * node scripts/retro-outcomes-live-check.mjs <base-url> <BaseData output directory>
 * A (English) and B (Thai) share one new board. Writes screenshots, downloads and report.json.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE_LABELS, CANVAS_SELECTOR, SYNC_TIMEOUT_MS, VIEWPORT, addSticky, addZone, download, openMenu, runLiveCheck, shot, step } from './board-live-helpers.mjs';

const BADGE_SELECTOR = '.rb-action-badge';
const DONE_BADGE_SELECTOR = '.rb-action-badge--done';
const STICKY_POSITION_PX = { x: 520, y: 380 };
const PRIVATE_POSITION_PX = { x: 900, y: 380 };
const ACTION_TEXT = 'Fix flaky CI';
const SECRET_TEXT = 'Secret salary idea';
const OWNER = 'Nok';
const ZONE_TITLE = 'ไปได้ดี';
const THAI_TEXT = 'ทีมช่วยกันรีวิวโค้ดเร็วขึ้นมากในสปรินต์นี้ ขอบคุณทุกคน';
const ZONE_DRAG_PX = { from: { x: 260, y: 600 }, to: { x: 1200, y: 880 } };
const ZONE_STICKY_PX = { x: 560, y: 720 };
const PAN_AWAY_WHEEL_PX = 3000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const LABELS = {
  en: { markAction: 'Mark as action item', actions: 'Action items', copySummary: 'Copy retro summary',
    exportPng: 'Export PNG', exportPdf: 'Export PDF', exportZip: 'Export', import: 'Import', importOk: 'Overwrite' },
  th: { actionsOpen: 'Action items (ค้าง 1)', actions: 'Action items', owner: 'ใครรับผิดชอบ?',
    markDone: 'ทำเครื่องหมายว่าเสร็จ', locate: 'ไปที่การ์ดบนบอร์ด' },
};

await runLiveCheck('retro-outcomes-live-check.mjs', async ({ a, b, report }) => {
  await step(report, 'A marks a sticky as an action item; B sees the badge', async () => {
    await addSticky(a, 'en', ACTION_TEXT, STICKY_POSITION_PX);
    await a.getByTitle(BASE_LABELS.en.reveal, { exact: true }).click();
    await a.getByTitle(LABELS.en.markAction, { exact: true }).click();
    await Promise.all([a.locator(BADGE_SELECTOR).waitFor(), b.locator(BADGE_SELECTOR).waitFor({ timeout: SYNC_TIMEOUT_MS })]);
  });
  await step(report, 'B sets owner and ticks done in the Thai panel; A sees both', async () => {
    await openMenu(b, 'th', LABELS.th.actionsOpen);
    await b.getByPlaceholder(LABELS.th.owner, { exact: true }).fill(OWNER);
    await b.getByPlaceholder(LABELS.th.owner, { exact: true }).press('Enter');
    await b.getByRole('button', { name: LABELS.th.markDone, exact: true }).click();
    await shot(b, 'panel-th.png', report);
    await b.keyboard.press('Escape');
    await a.locator(DONE_BADGE_SELECTOR).filter({ hasText: OWNER }).waitFor({ timeout: SYNC_TIMEOUT_MS });
    await shot(a, 'board-en-badge.png', report);
  });
  await step(report, 'undo and redo of the done tick sync both ways', async () => {
    await b.locator(CANVAS_SELECTOR).click({ position: { x: 200, y: 700 } });
    await b.keyboard.press('Control+z');
    await a.locator(DONE_BADGE_SELECTOR).waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS });
    await b.keyboard.press('Control+Shift+z');
    await a.locator(DONE_BADGE_SELECTOR).waitFor({ timeout: SYNC_TIMEOUT_MS });
  });
  await step(report, 'B adds a private card that A cannot read', async () => {
    // New cards start private, so B's card stays hidden from A.
    await addSticky(b, 'th', SECRET_TEXT, PRIVATE_POSITION_PX);
    await b.keyboard.press('Escape');
    await a.getByText(SECRET_TEXT, { exact: true }).waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS });
  });
  await step(report, 'A copies a summary with the checklist and without the private card', async () => {
    await openMenu(a, 'en', LABELS.en.copySummary);
    const text = await a.evaluate(() => navigator.clipboard.readText());
    await writeFile(join(report.out, 'summary.md'), text);
    if (!text.includes(`- [x] ${ACTION_TEXT} — ${OWNER}`)) throw new Error(`checklist line missing:\n${text}`);
    if (text.includes(SECRET_TEXT)) throw new Error('private card leaked into the summary');
    if (!text.includes('1 hidden cards not shown')) throw new Error('hidden card count missing');
    return { summary: text };
  });
  await step(report, 'B pans away, then Locate in the panel brings the card back into view', async () => {
    await b.locator(CANVAS_SELECTOR).hover({ position: { x: 700, y: 600 } });
    await b.mouse.wheel(PAN_AWAY_WHEEL_PX, PAN_AWAY_WHEEL_PX);
    const card = b.getByText(ACTION_TEXT, { exact: true });
    const away = await card.boundingBox();
    await openMenu(b, 'th', LABELS.th.actions); // all done, so no open count
    await b.getByRole('button', { name: LABELS.th.locate, exact: true }).click();
    await b.locator('.rb-action-list').waitFor({ state: 'detached' });
    const box = await card.boundingBox();
    const inView = box && box.x >= 0 && box.y >= 0 && box.x + box.width <= VIEWPORT.width && box.y + box.height <= VIEWPORT.height;
    if (!inView) throw new Error(`card not in view after Locate: ${JSON.stringify(box)}`);
    return { before: away, after: box };
  });
  await step(report, 'A adds a Thai zone with a Thai sticky for the image export', async () => {
    await addZone(a, ZONE_TITLE, ZONE_DRAG_PX);
    await addSticky(a, 'en', THAI_TEXT, ZONE_STICKY_PX);
    await a.getByTitle(BASE_LABELS.en.reveal, { exact: true }).click();
    await a.keyboard.press('Escape');
    await b.getByText(THAI_TEXT, { exact: true }).waitFor({ timeout: SYNC_TIMEOUT_MS });
  });
  await step(report, 'A exports PNG and PDF', async () => {
    const png = await readFile(await download(a, 'en', LABELS.en.exportPng, report));
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
    const pdf = await readFile(await download(a, 'en', LABELS.en.exportPdf, report));
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
    return { pngWidth: png.readUInt32BE(PNG_WIDTH_OFFSET), pngHeight: png.readUInt32BE(PNG_HEIGHT_OFFSET), pdfBytes: pdf.length };
  });
  await step(report, 'ZIP export then import keeps the action-item fields', async () => {
    const zip = await download(a, 'en', LABELS.en.exportZip, report);
    const chooser = a.waitForEvent('filechooser');
    await openMenu(a, 'en', LABELS.en.import);
    await (await chooser).setFiles(zip);
    await a.getByRole('button', { name: LABELS.en.importOk, exact: true }).click();
    await a.locator(DONE_BADGE_SELECTOR).filter({ hasText: OWNER }).waitFor({ timeout: SYNC_TIMEOUT_MS });
    await b.locator(DONE_BADGE_SELECTOR).filter({ hasText: OWNER }).waitFor({ timeout: SYNC_TIMEOUT_MS });
    await openMenu(a, 'en', LABELS.en.actions);
    await shot(a, 'panel-en.png', report);
  });
});
