// Shared Playwright helpers for two-participant board live checks
// (retro-outcomes-live-check.mjs, facilitation-live-check.mjs, account-live-check.mjs, room-lock-live-check.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VIEWPORT = { width: 1440, height: 900 };
export const SYNC_TIMEOUT_MS = 15_000;
export const CANVAS_SELECTOR = '.rb-no-select';
const ACTION_TIMEOUT_MS = 15_000;
const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
const JSON_INDENT_SPACES = 2;
// AGENTS.md §Data location: live-check output lives on a mounted data volume, never a fallback.
export const DATA_VOLUME_ROOTS = Object.freeze(['/Volumes/ssd-fluke/BaseData', '/Volumes/BaseDisk/Base']);
const VOLUMES_DIR = '/Volumes';
const MOUNT_PATH_SEGMENTS = 3;

const isWithinDirectory = (path, directory) => path === directory || path.startsWith(`${directory}${sep}`);
const mountOf = (root) => root.split(sep).slice(0, MOUNT_PATH_SEGMENTS).join(sep);

/** Creates `out` under a mounted data volume and returns its real path; anything else throws. */
export async function prepareDataVolumeOutput(out, roots = DATA_VOLUME_ROOTS) {
  const target = resolve(out);
  const root = roots.find((candidate) => isWithinDirectory(target, candidate));
  if (!root) throw new Error(`output must be under ${roots.join(' or ')}; no fallback.`);
  const [mount, volumes] = await Promise.all([stat(mountOf(root)), stat(VOLUMES_DIR)]);
  if (mount.dev === volumes.dev) throw new Error(`${mountOf(root)} is not mounted; refusing output fallback.`);
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!isWithinDirectory(realpathSync(ancestor), realpathSync(root))) throw new Error('output traverses a symlink outside its data volume.');
  await mkdir(target, { recursive: true });
  return realpathSync(target);
}

export const BASE_LABELS = {
  en: { create: 'Create', namePlaceholder: 'e.g. "Fluke"', nameConfirm: 'Enter room', sticky: 'Double-click to edit',
    more: 'More', reveal: 'Off: hide in the normal UI (not encrypted)', signIn: 'Sign in with Google' },
  th: { create: 'สร้างห้อง', namePlaceholder: 'เช่น "ฟลุค"', nameConfirm: 'เข้าห้อง', sticky: 'ดับเบิลคลิกเพื่อแก้ไข', more: 'เพิ่มเติม',
    reveal: 'ปิด: ซ่อนในหน้าจอปกติ (ไม่ได้เข้ารหัส)', signIn: 'เข้าสู่ระบบด้วย Google' },
};
export const UNDO_KEY = 'ControlOrMeta+z';
export const REDO_KEY = 'ControlOrMeta+Shift+z';
const UNDO_PRESS_LIMIT = 12;
const UNDO_SETTLE_TIMEOUT_MS = 2_000;

export async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_MODULE || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright');
  const entry = join(dir, 'index.mjs');
  if (!existsSync(entry)) throw new Error(`Playwright missing at ${entry}`);
  return import(pathToFileURL(entry).href);
}

export async function participant(browser, lang, report, name) {
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript((value) => { if (!localStorage.getItem('rb_lang')) localStorage.setItem('rb_lang', value); }, lang);
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.on('pageerror', error => report.pageErrors.push({ name, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ name, text: message.text(), url: message.location().url }); });
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

// New stickies start private, so each one is revealed for the other participant.
export async function addSharedSticky(page, lang, text, position) {
  await addSticky(page, lang, text, position);
  await page.getByTitle(BASE_LABELS[lang].reveal, { exact: true }).click();
}

export const waitForTextOn = (pages, text, state = 'visible') => Promise.all(
  pages.map(page => page.getByText(text, { exact: true }).waitFor({ state, timeout: SYNC_TIMEOUT_MS })),
);

/** Presses undo until `text` is gone; returns how many presses it took, for the matching redo. */
export async function undoUntilHidden(page, text) {
  for (let presses = 1; presses <= UNDO_PRESS_LIMIT; presses += 1) {
    await page.keyboard.press(UNDO_KEY);
    try {
      await page.getByText(text, { exact: true }).waitFor({ state: 'hidden', timeout: UNDO_SETTLE_TIMEOUT_MS });
      return presses;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
  }
  throw new Error(`"${text}" still shows after ${UNDO_PRESS_LIMIT} undo presses.`);
}

/** Opens the landing page and waits for its Create button in either language. */
export async function openLanding(page, baseUrl) {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: BASE_LABELS.en.create, exact: true })
    .or(page.getByRole('button', { name: BASE_LABELS.th.create, exact: true })).first().waitFor();
}

export const signInLink = (page, lang) => page.getByRole('link', { name: BASE_LABELS[lang].signIn, exact: true });
/** The fake Google consent page's buttons (scripts/fake-google-oidc.mjs). */
export const FAKE_GOOGLE_DECISION = Object.freeze({ APPROVE: '#approve', CANCEL: '#cancel' });

/** Goes through the fake Google consent page with `decision` and returns to the landing page. */
export async function visitStub(page, baseUrl, decision) {
  await signInLink(page, 'en').click();
  await page.locator(decision).click();
  await page.waitForURL((url) => url.origin === new URL(baseUrl).origin);
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

/**
 * CLI entry: `<script> <base-url> <output-dir>`; `scenario({a, b, report, browser, baseUrl})` runs the steps.
 * `setup(browser, baseUrl, report)` prepares the participants; by default A creates a board and B joins it.
 */
export async function runLiveCheck(scriptName, scenario, { setup = sharedBoard } = {}) {
  const [baseUrl, out] = process.argv.slice(2);
  if (!baseUrl || !out) throw new Error(`usage: ${scriptName} <base-url> <output-dir>`);
  await prepareDataVolumeOutput(out);
  const report = { baseUrl, out, pages: [], steps: [], files: [], screenshots: [], pageErrors: [], consoleErrors: [] };
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    await scenario({ ...(await setup(browser, baseUrl, report)), report, browser, baseUrl });
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
