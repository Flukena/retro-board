// Shared Playwright helpers for two-participant board live checks
// (retro-outcomes-live-check.mjs, facilitation-live-check.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VIEWPORT = { width: 1440, height: 900 };
export const SYNC_TIMEOUT_MS = 15_000;
export const CANVAS_SELECTOR = '.rb-no-select';
const ACTION_TIMEOUT_MS = 15_000;
const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
const JSON_INDENT_SPACES = 2;

export const BASE_LABELS = {
  en: { create: 'Create', namePlaceholder: 'e.g. "Fluke"', nameConfirm: 'Enter room', sticky: 'Double-click to edit',
    more: 'More', reveal: 'Off: hide in the normal UI (not encrypted)' },
  th: { namePlaceholder: 'เช่น "ฟลุค"', nameConfirm: 'เข้าห้อง', sticky: 'ดับเบิลคลิกเพื่อแก้ไข', more: 'เพิ่มเติม',
    reveal: 'ปิด: ซ่อนในหน้าจอปกติ (ไม่ได้เข้ารหัส)' },
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

export async function enter(page, lang, name) {
  const prompt = page.getByPlaceholder(BASE_LABELS[lang].namePlaceholder, { exact: true });
  await prompt.or(page.locator(CANVAS_SELECTOR)).first().waitFor();
  if (await prompt.isVisible()) {
    await prompt.fill(name);
    await page.getByRole('button', { name: BASE_LABELS[lang].nameConfirm, exact: true }).click();
  }
  await page.locator(CANVAS_SELECTOR).waitFor();
}

export async function addSticky(page, lang, text, position) {
  await page.locator(CANVAS_SELECTOR).dblclick({ position });
  const editor = page.getByPlaceholder(BASE_LABELS[lang].sticky, { exact: true });
  await editor.fill(text);
  await editor.press('Escape');
  await page.getByText(text, { exact: true }).waitFor();
}

const EMPTY_CLICK_PX = { x: 200, y: 200 };
const ZONE_DRAG_STEPS = 8;

/** Draws a zone with the Zone tool and names it; `drag` is { from, to } in page pixels. */
export async function addZone(page, title, drag) {
  await page.locator(CANVAS_SELECTOR).click({ position: EMPTY_CLICK_PX });
  await page.locator('[data-tool="zone"]').click();
  await page.mouse.move(drag.from.x, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(drag.to.x, drag.to.y, { steps: ZONE_DRAG_STEPS });
  await page.mouse.up();
  // The new zone focuses and selects its title shortly after mouseup.
  await page.waitForFunction(() => document.activeElement?.matches?.('textarea, input, [contenteditable="true"]'));
  await page.keyboard.type(title);
  await page.keyboard.press('Escape');
  await page.getByText(title, { exact: true }).waitFor();
}

export async function openMenu(page, lang, label) {
  await page.getByTitle(BASE_LABELS[lang].more, { exact: true }).click();
  await page.getByText(label, { exact: true }).click();
}

export async function download(page, lang, label, report) {
  const pending = page.waitForEvent('download', { timeout: SYNC_TIMEOUT_MS * 2 });
  pending.catch(() => {}); // A failed menu click is reported instead; avoid an unhandled rejection.
  await openMenu(page, lang, label);
  const file = await pending;
  const path = join(report.out, file.suggestedFilename());
  await file.saveAs(path);
  report.files.push(path);
  return path;
}

// Banners fade in, so a screenshot taken right after an element appears can miss it.
const finiteAnimationsDone = () => document.getAnimations()
  .every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().endTime === Infinity);

export async function shot(page, name, report) {
  const path = join(report.out, name);
  await page.waitForFunction(finiteAnimationsDone);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

/** Runs one named step; on failure records it, screenshots every page, and rethrows. */
export async function step(report, name, action) {
  try {
    report.steps.push({ name, passed: true, details: await action() ?? null });
  } catch (error) {
    report.steps.push({ name, passed: false, error: error.message });
    await Promise.all(report.pages.map((page, index) => page.screenshot({ path: join(report.out, `failure-${index}.png`) }).catch(() => {})));
    throw error;
  }
}

/** A (English, board creator) and B (Thai) on one new board. */
async function sharedBoard(browser, baseUrl, report) {
  const a = await participant(browser, 'en', report, 'A');
  const b = await participant(browser, 'th', report, 'B');
  report.pages.push(a, b);
  await step(report, 'A creates board, B joins', async () => {
    await a.goto(baseUrl);
    await a.getByRole('button', { name: BASE_LABELS.en.create, exact: true }).click();
    await a.waitForURL(BOARD_URL_PATTERN);
    await enter(a, 'en', 'Ada');
    await b.goto(a.url());
    await enter(b, 'th', 'บี');
    return { boardUrl: a.url() };
  });
  return { a, b };
}

/** CLI entry: `<script> <base-url> <output-dir>`; `scenario({a, b, report})` runs the steps. */
export async function runLiveCheck(scriptName, scenario) {
  const [baseUrl, out] = process.argv.slice(2);
  if (!baseUrl || !out) throw new Error(`usage: ${scriptName} <base-url> <output-dir>`);
  await mkdir(out, { recursive: true });
  const report = { baseUrl, out, pages: [], steps: [], files: [], screenshots: [], pageErrors: [], consoleErrors: [] };
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    await scenario({ ...(await sharedBoard(browser, baseUrl, report)), report });
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    const { pages, ...saved } = report;
    await writeFile(join(out, 'report.json'), JSON.stringify(saved, null, JSON_INDENT_SPACES));
    console.log(report.steps.map(s => `${s.passed ? 'PASS' : 'FAIL'} ${s.name}`).join('\n'));
  }
}
