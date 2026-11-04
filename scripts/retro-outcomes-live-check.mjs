#!/usr/bin/env node
/**
 * Two-participant live check for action items, the retro summary and PNG/PDF/ZIP export.
 * Start isolated servers first (see ui-live-check.mjs for the env; pick free ports), then:
 * node scripts/retro-outcomes-live-check.mjs <base-url> <BaseData output directory>
 * A (English) and B (Thai) share one new board. Writes screenshots, downloads and report.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VIEWPORT = { width: 1440, height: 900 };
const ACTION_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 15_000;
const CANVAS_SELECTOR = '.rb-no-select';
const BADGE_SELECTOR = '.rb-action-badge';
const DONE_BADGE_SELECTOR = '.rb-action-badge--done';
const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
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
const JSON_INDENT_SPACES = 2;
const LABELS = {
  en: { create: 'Create', namePlaceholder: 'e.g. "Fluke"', nameConfirm: 'Enter room', sticky: 'Double-click to edit',
    more: 'More', markAction: 'Mark as action item', actions: 'Action items', actionsOpen: 'Action items (1 open)',
    copySummary: 'Copy retro summary', exportPng: 'Export PNG', exportPdf: 'Export PDF', exportZip: 'Export',
    import: 'Import', importOk: 'Overwrite', owner: 'Who owns it?', markDone: 'Mark done', reveal: 'Off: hide in the normal UI (not encrypted)' },
  th: { namePlaceholder: 'เช่น "ฟลุค"', nameConfirm: 'เข้าห้อง', sticky: 'ดับเบิลคลิกเพื่อแก้ไข', more: 'เพิ่มเติม',
    actionsOpen: 'Action items (ค้าง 1)', actions: 'Action items', owner: 'ใครรับผิดชอบ?',
    markDone: 'ทำเครื่องหมายว่าเสร็จ', locate: 'ไปที่การ์ดบนบอร์ด' },
};

async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_MODULE || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright');
  const entry = join(dir, 'index.mjs');
  if (!existsSync(entry)) throw new Error(`Playwright missing at ${entry}`);
  return import(pathToFileURL(entry).href);
}

async function participant(browser, lang, report, name) {
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript((value) => { if (!localStorage.getItem('rb_lang')) localStorage.setItem('rb_lang', value); }, lang);
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.on('pageerror', error => report.pageErrors.push({ name, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ name, text: message.text() }); });
  return page;
}

async function enter(page, lang, name) {
  const prompt = page.getByPlaceholder(LABELS[lang].namePlaceholder, { exact: true });
  await prompt.or(page.locator(CANVAS_SELECTOR)).first().waitFor();
  if (await prompt.isVisible()) {
    await prompt.fill(name);
    await page.getByRole('button', { name: LABELS[lang].nameConfirm, exact: true }).click();
  }
  await page.locator(CANVAS_SELECTOR).waitFor();
}

async function addSticky(page, lang, text, position) {
  await page.locator(CANVAS_SELECTOR).dblclick({ position });
  const editor = page.getByPlaceholder(LABELS[lang].sticky, { exact: true });
  await editor.fill(text);
  await editor.press('Escape');
  await page.getByText(text, { exact: true }).waitFor();
}

async function openMenu(page, lang, label) {
  await page.getByTitle(LABELS[lang].more, { exact: true }).click();
  await page.getByText(label, { exact: true }).click();
}

async function download(page, lang, label, out, report) {
  const pending = page.waitForEvent('download', { timeout: SYNC_TIMEOUT_MS * 2 });
  pending.catch(() => {}); // A failed menu click is reported instead; avoid an unhandled rejection.
  await openMenu(page, lang, label);
  const file = await pending;
  const path = join(out, file.suggestedFilename());
  await file.saveAs(path);
  report.files.push(path);
  return path;
}

async function shot(page, out, name, report) {
  const path = join(out, name);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

async function step(report, name, action) {
  try {
    report.steps.push({ name, passed: true, details: await action() ?? null });
  } catch (error) {
    report.steps.push({ name, passed: false, error: error.message });
    await Promise.all(report.pages.map((page, index) => page.screenshot({ path: join(report.out, `failure-${index}.png`) }).catch(() => {})));
    throw error;
  }
}

async function run(baseUrl, out) {
  const report = { baseUrl, out, pages: [], steps: [], files: [], screenshots: [], pageErrors: [], consoleErrors: [] };
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    const a = await participant(browser, 'en', report, 'A');
    const b = await participant(browser, 'th', report, 'B');
    report.pages.push(a, b);
    await step(report, 'A creates board, B joins', async () => {
      await a.goto(baseUrl);
      await a.getByRole('button', { name: LABELS.en.create, exact: true }).click();
      await a.waitForURL(BOARD_URL_PATTERN);
      await enter(a, 'en', 'Ada');
      await b.goto(a.url());
      await enter(b, 'th', 'บี');
      return { boardUrl: a.url() };
    });
    await step(report, 'A marks a sticky as an action item; B sees the badge', async () => {
      await addSticky(a, 'en', ACTION_TEXT, STICKY_POSITION_PX);
      await a.getByTitle(LABELS.en.reveal, { exact: true }).click();
      await a.getByTitle(LABELS.en.markAction, { exact: true }).click();
      await Promise.all([a.locator(BADGE_SELECTOR).waitFor(), b.locator(BADGE_SELECTOR).waitFor({ timeout: SYNC_TIMEOUT_MS })]);
    });
    await step(report, 'B sets owner and ticks done in the Thai panel; A sees both', async () => {
      await openMenu(b, 'th', LABELS.th.actionsOpen);
      await b.getByPlaceholder(LABELS.th.owner, { exact: true }).fill(OWNER);
      await b.getByPlaceholder(LABELS.th.owner, { exact: true }).press('Enter');
      await b.getByRole('button', { name: LABELS.th.markDone, exact: true }).click();
      await shot(b, out, 'panel-th.png', report);
      await b.keyboard.press('Escape');
      await a.locator(DONE_BADGE_SELECTOR).filter({ hasText: OWNER }).waitFor({ timeout: SYNC_TIMEOUT_MS });
      await shot(a, out, 'board-en-badge.png', report);
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
      await writeFile(join(out, 'summary.md'), text);
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
      await a.locator(CANVAS_SELECTOR).click({ position: { x: 200, y: 200 } });
      await a.locator('[data-tool="zone"]').click();
      await a.mouse.move(ZONE_DRAG_PX.from.x, ZONE_DRAG_PX.from.y);
      await a.mouse.down();
      await a.mouse.move(ZONE_DRAG_PX.to.x, ZONE_DRAG_PX.to.y, { steps: 8 });
      await a.mouse.up();
      // The new zone focuses and selects its title shortly after mouseup.
      await a.waitForFunction(() => document.activeElement?.matches?.('textarea, input, [contenteditable="true"]'));
      await a.keyboard.type(ZONE_TITLE);
      await a.keyboard.press('Escape');
      await a.getByText(ZONE_TITLE, { exact: true }).waitFor();
      await addSticky(a, 'en', THAI_TEXT, ZONE_STICKY_PX);
      await a.getByTitle(LABELS.en.reveal, { exact: true }).click();
      await a.keyboard.press('Escape');
      await b.getByText(THAI_TEXT, { exact: true }).waitFor({ timeout: SYNC_TIMEOUT_MS });
    });
    await step(report, 'A exports PNG and PDF', async () => {
      const png = await readFile(await download(a, 'en', LABELS.en.exportPng, out, report));
      if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
      const pdf = await readFile(await download(a, 'en', LABELS.en.exportPdf, out, report));
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
      return { pngWidth: png.readUInt32BE(PNG_WIDTH_OFFSET), pngHeight: png.readUInt32BE(PNG_HEIGHT_OFFSET), pdfBytes: pdf.length };
    });
    await step(report, 'ZIP export then import keeps the action-item fields', async () => {
      const zip = await download(a, 'en', LABELS.en.exportZip, out, report);
      const chooser = a.waitForEvent('filechooser');
      await openMenu(a, 'en', LABELS.en.import);
      await (await chooser).setFiles(zip);
      await a.getByRole('button', { name: LABELS.en.importOk, exact: true }).click();
      await a.locator(DONE_BADGE_SELECTOR).filter({ hasText: OWNER }).waitFor({ timeout: SYNC_TIMEOUT_MS });
      await b.locator(DONE_BADGE_SELECTOR).filter({ hasText: OWNER }).waitFor({ timeout: SYNC_TIMEOUT_MS });
      await openMenu(a, 'en', LABELS.en.actions);
      await shot(a, out, 'panel-en.png', report);
    });
  } finally {
    await browser.close();
    const { pages, ...saved } = report;
    await writeFile(join(out, 'report.json'), JSON.stringify(saved, null, JSON_INDENT_SPACES));
  }
  return report;
}

const [baseUrl, out] = process.argv.slice(2);
if (!baseUrl || !out) throw new Error('usage: retro-outcomes-live-check.mjs <base-url> <output-dir>');
await mkdir(out, { recursive: true });
run(baseUrl, out).then(
  report => { console.log(JSON.stringify(report.steps.map(s => `${s.passed ? 'PASS' : 'FAIL'} ${s.name}`), null, JSON_INDENT_SPACES)); },
  error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; },
);
