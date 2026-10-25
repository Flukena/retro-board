#!/usr/bin/env node
/**
 * Disposable live UI check (servers are normally started by the caller):
 * VITE_YJS_PORT=1240 npx vite --port 5180 --strictPort
 * YJS_ALLOW_INSECURE_HTTP=true YJS_PORT=1240 \
 *   YJS_ROOM_CREATE_BURST=100 YJS_ROOM_CREATES_PER_HOUR=1000 \
 *   YJS_ALLOWED_ORIGINS=http://127.0.0.1:5180,http://localhost:5180 \
 *   YJS_DB_DIR=<BaseData>/db YJS_UPLOADS_DIR=<BaseData>/uploads node yjs-server.mjs
 * node scripts/ui-live-check.mjs --base-url http://127.0.0.1:5180 --out <BaseData>/run
 * Optional: --strict-console; PLAYWRIGHT_MODULE=/absolute/path/to/playwright
 * Creates one disposable board; report.json contains its full capability URL.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { Z } from '../src/client/chrome/chrome-layout.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:5180';
const BASE_DATA_DIR = '/Volumes/BaseDisk/Base';
const SSD_MOUNT_DIR = '/Volumes/BaseDisk';
const VIEWPORT_DESKTOP = { width: 1440, height: 900 };
const VIEWPORT_NARROW = { width: 390, height: 844 };
const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SYNC_TIMEOUT_MS = 15_000;
const UNDO_SETTLE_TIMEOUT_MS = 2_000;
const UNDO_PRESS_LIMIT = 12;
const POPOVER_DISMISS_CLICK_LIMIT = 4;
const FIRST_PRESS_COUNT = 1;
const ARG_VALUE_OFFSET_COUNT = 1;
const NODE_ARGUMENT_OFFSET_COUNT = 2;
const LANG_STORAGE_KEY = 'rb_lang';
const THEME_STORAGE_KEY = 'rb_theme';
const OPAQUE_ORIGIN = 'null';
const BACKDROP_POSITION = 'fixed';
const BACKDROP_Z_INDICES = [Z.POPOVER_BACKDROP, Z.TOOLBAR_POPOVER_BACKDROP];
const REPORT_FILENAME = 'report.json';
const CANVAS_SELECTOR = '.rb-no-select';
const THEME_ATTRIBUTE = 'data-theme';
const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
const SHORTCUT_UNDO_KEY = 'Control+z';
const SHORTCUT_REDO_KEY = 'Control+Shift+z';
const SHORTCUT_ESCAPE_KEY = 'Escape';
const STICKY_POSITION_A_PX = { x: 480, y: 360 };
const STICKY_POSITION_B_PX = { x: 960, y: 360 };
const PARTICIPANT_NAME_A = 'UI check A';
const PARTICIPANT_NAME_B = 'UI check B';
const CREATE_BUTTON_LABEL = 'Create';
const SYNC_DIRECTION_A_TO_B = 'A→B';
const SYNC_DIRECTION_B_TO_A = 'B→A';
const STEP_NAMES = {
  launch: 'launch two contexts', create: 'create board', join: 'join board',
  syncA: `sync ${SYNC_DIRECTION_A_TO_B}`, syncB: `sync ${SYNC_DIRECTION_B_TO_A}`,
  undo: 'undo in both contexts', redo: 'redo in both contexts',
  narrow: 'board th/light narrow', close: 'close browser',
};
const LABELS = {
  en: {
    landingTagline: 'Create or join a real-time retrospective room',
    namePlaceholder: 'e.g. "Fluke"', nameConfirm: 'Enter room',
    stickyPlaceholder: 'Double-click to edit',
    revealTitle: 'Off: hide in the normal UI (not encrypted)',
    undoTitle: 'Undo (Ctrl+Z)',
    nothingToUndoTitle: 'Nothing to undo (only reverts your own edits from this tab)',
  },
  th: {
    landingTagline: 'สร้างหรือเข้าร่วมห้อง retrospective แบบ real-time',
    namePlaceholder: 'เช่น "ฟลุค"', nameConfirm: 'เข้าห้อง',
    stickyPlaceholder: 'ดับเบิลคลิกเพื่อแก้ไข',
    revealTitle: 'ปิด: ซ่อนในหน้าจอปกติ (ไม่ได้เข้ารหัส)',
    undoTitle: 'ย้อนกลับ (Ctrl+Z)',
    nothingToUndoTitle: 'ไม่มีอะไรให้ย้อนกลับ (ย้อนได้แค่สิ่งที่คุณเพิ่งแก้เองในแท็บนี้)',
  },
};
const APPEARANCES = [
  { lang: 'th', theme: 'light' }, { lang: 'th', theme: 'dark' },
  { lang: 'en', theme: 'light' }, { lang: 'en', theme: 'dark' },
];
const INITIAL_APPEARANCE_A = { lang: 'en', theme: 'light' };
const INITIAL_APPEARANCE_B = { lang: 'th', theme: 'light' };
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const JSON_INDENT_SPACES = 2;

function parseOptions(args) {
  const options = { baseUrl: DEFAULT_BASE_URL, strictConsole: false };
  const valueFlags = new Map([['--base-url', 'baseUrl'], ['--out', 'out']]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--strict-console') options.strictConsole = true;
    else {
      const key = valueFlags.get(flag);
      const value = args[index + ARG_VALUE_OFFSET_COUNT];
      if (!key || !value || value.startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
      options[key] = value;
      index += 1;
    }
  }
  if (!options.out) throw new Error('--out <BaseData directory> is required; no output fallback.');
  const url = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--base-url must use HTTP or HTTPS.');
  options.baseUrl = url.origin;
  options.out = resolve(options.out);
  return options;
}

function isWithinDirectory(path, directory) {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

async function prepareOutput(out) {
  const [mount, parent] = await Promise.all([stat(SSD_MOUNT_DIR), stat(dirname(SSD_MOUNT_DIR))]);
  if (mount.dev === parent.dev) throw new Error('BaseData SSD is not mounted; refusing output fallback.');
  const base = realpathSync(BASE_DATA_DIR);
  if (!isWithinDirectory(out, base)) throw new Error(`--out must be under ${BASE_DATA_DIR}.`);
  let ancestor = out;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!isWithinDirectory(realpathSync(ancestor), base)) throw new Error('--out traverses a symlink outside BaseData.');
  await mkdir(out, { recursive: true });
  return realpathSync(out);
}

async function loadPlaywright() {
  const moduleDir = process.env.PLAYWRIGHT_MODULE
    || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright');
  if (!isAbsolute(moduleDir)) throw new Error('PLAYWRIGHT_MODULE must be an absolute module path.');
  const entry = moduleDir.endsWith('.mjs') ? moduleDir : join(moduleDir, 'index.mjs');
  if (!existsSync(entry)) throw new Error(`Playwright missing at ${entry}; set PLAYWRIGHT_MODULE to the global install.`);
  return import(pathToFileURL(entry).href);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runStep(report, name, action) {
  const started = performance.now();
  const step = { name, passed: false, durationMs: 0 };
  report.steps.push(step);
  try {
    step.details = await action();
    step.passed = true;
  } catch (error) {
    step.error = errorMessage(error);
  } finally {
    step.durationMs = Math.round(performance.now() - started);
  }
  return step.passed;
}

function collectErrors(context, participant, report) {
  context.on('page', (page) => {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      report.consoleErrors.push({ participant, text: message.text(), location: message.location(), url: page.url() });
    });
    page.on('pageerror', (error) => {
      report.pageErrors.push({ participant, message: error.message, stack: error.stack, url: page.url() });
    });
  });
}

function setStoredAppearance({ appearance, langKey, themeKey }) {
  localStorage.setItem(langKey, appearance.lang);
  localStorage.setItem(themeKey, appearance.theme);
}

function appearancePayload(appearance) {
  return { appearance, langKey: LANG_STORAGE_KEY, themeKey: THEME_STORAGE_KEY, opaqueOrigin: OPAQUE_ORIGIN };
}

async function createParticipant(browser, participant, appearance, report) {
  const context = await browser.newContext({ viewport: VIEWPORT_DESKTOP });
  collectErrors(context, participant, report);
  await context.addInitScript(({ appearance: initial, langKey, themeKey, opaqueOrigin }) => {
    if (location.origin === opaqueOrigin) return;
    if (!localStorage.getItem(langKey)) localStorage.setItem(langKey, initial.lang);
    if (!localStorage.getItem(themeKey)) localStorage.setItem(themeKey, initial.theme);
  }, appearancePayload(appearance));
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  return page;
}

async function applyAppearance(page, appearance) {
  await page.evaluate(setStoredAppearance, appearancePayload(appearance));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator(`html[${THEME_ATTRIBUTE}="${appearance.theme}"]`).waitFor();
}

async function captureScreenshot(page, filename, report, out) {
  const fontsLoaded = await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, {
    timeout: ACTION_TIMEOUT_MS,
  });
  await fontsLoaded.dispose();
  const path = join(out, filename);
  await page.screenshot({ path, fullPage: true, animations: 'disabled', timeout: ACTION_TIMEOUT_MS });
  report.screenshots.push(path);
  return { screenshot: path };
}

async function landingScreenshot(page, options, appearance, report) {
  await page.goto(options.baseUrl, { waitUntil: 'domcontentloaded' });
  await applyAppearance(page, appearance);
  await page.getByRole('button', { name: CREATE_BUTTON_LABEL, exact: true }).waitFor();
  await page.getByText(LABELS[appearance.lang].landingTagline, { exact: true }).waitFor();
  return captureScreenshot(page, `landing-${appearance.lang}-${appearance.theme}.png`, report, options.out);
}

async function passNamePrompt(page, lang, name) {
  const labels = LABELS[lang];
  const prompt = page.getByPlaceholder(labels.namePlaceholder, { exact: true });
  // Identity loads asynchronously; generic chrome can appear before the name prompt.
  await prompt.or(page.getByText(name, { exact: true })).first().waitFor();
  if (await prompt.isVisible()) {
    await prompt.fill(name);
    await page.getByRole('button', { name: labels.nameConfirm, exact: true }).click();
    await prompt.waitFor({ state: 'hidden' });
  }
  await page.locator(CANVAS_SELECTOR).waitFor();
}

async function inspectStickyPosition(page, positionPx) {
  return page.locator(CANVAS_SELECTOR).evaluate((canvas, { position, backdropPosition, backdropZIndices }) => {
    const canvasRect = canvas.getBoundingClientRect();
    const xPx = canvasRect.left + canvas.clientLeft + position.x;
    const yPx = canvasRect.top + canvas.clientTop + position.y;
    const hit = document.elementFromPoint(xPx, yPx);
    if (!hit) return { xPx, yPx, receivesPointer: false, isBackdrop: false, target: 'no element' };
    const style = getComputedStyle(hit);
    const rect = hit.getBoundingClientRect();
    const coversViewport = rect.left <= 0 && rect.top <= 0
      && rect.right >= innerWidth && rect.bottom >= innerHeight;
    return {
      xPx, yPx, receivesPointer: canvas.contains(hit),
      isBackdrop: style.position === backdropPosition && coversViewport
        && backdropZIndices.includes(Number(style.zIndex)),
      target: `${hit.tagName} (position=${style.position}, z-index=${style.zIndex})`,
    };
  }, { position: positionPx, backdropPosition: BACKDROP_POSITION, backdropZIndices: BACKDROP_Z_INDICES });
}

async function dismissOpenPopovers(page, positionPx = STICKY_POSITION_A_PX) {
  for (let count = 0; count < POPOVER_DISMISS_CLICK_LIMIT; count += 1) {
    const hit = await inspectStickyPosition(page, positionPx);
    if (!hit.isBackdrop) return;
    await page.mouse.click(hit.xPx, hit.yPx);
  }
  const hit = await inspectStickyPosition(page, positionPx);
  if (hit.isBackdrop) {
    throw new Error(`Popover backdrop still covers (${hit.xPx}, ${hit.yPx}) after ${POPOVER_DISMISS_CLICK_LIMIT} clicks.`);
  }
}

async function assertCanvasReceivesPointer(page, positionPx) {
  const hit = await inspectStickyPosition(page, positionPx);
  if (!hit.receivesPointer) {
    throw new Error(`Cannot create sticky: canvas is blocked at (${hit.xPx}, ${hit.yPx}) by ${hit.target}.`);
  }
}

async function createBoard(page, options, report) {
  await page.goto(options.baseUrl, { waitUntil: 'domcontentloaded' });
  await applyAppearance(page, INITIAL_APPEARANCE_A);
  await page.getByRole('button', { name: CREATE_BUTTON_LABEL, exact: true }).click();
  await page.waitForURL(BOARD_URL_PATTERN, { waitUntil: 'domcontentloaded' });
  report.boardUrl = page.url();
  await passNamePrompt(page, INITIAL_APPEARANCE_A.lang, PARTICIPANT_NAME_A);
  await dismissOpenPopovers(page);
  return { boardUrl: report.boardUrl };
}

async function joinBoard(page, report) {
  if (!report.boardUrl) throw new Error('Board creation did not produce a URL.');
  await page.goto(report.boardUrl, { waitUntil: 'domcontentloaded' });
  await passNamePrompt(page, INITIAL_APPEARANCE_B.lang, PARTICIPANT_NAME_B);
  await dismissOpenPopovers(page, STICKY_POSITION_B_PX);
}

async function createSticky(page, lang, text, positionPx) {
  await assertCanvasReceivesPointer(page, positionPx);
  await page.locator(CANVAS_SELECTOR).dblclick({ position: positionPx });
  const editor = page.getByPlaceholder(LABELS[lang].stickyPlaceholder, { exact: true });
  await editor.fill(text);
  const card = await editor.evaluateHandle((element) => element.parentElement.parentElement);
  await editor.press(SHORTCUT_ESCAPE_KEY);
  await page.getByTitle(LABELS[lang].revealTitle, { exact: true }).click();
  await page.keyboard.press(SHORTCUT_ESCAPE_KEY);
  return card;
}

async function waitForText(page, text, state = 'visible') {
  await page.getByText(text, { exact: true }).waitFor({ state, timeout: SYNC_TIMEOUT_MS });
}

async function checkSync(state, direction) {
  if (!state.joined) throw new Error('Both participants must join before sync checks.');
  const fromA = direction === SYNC_DIRECTION_A_TO_B;
  const source = fromA ? state.pageA : state.pageB;
  const target = fromA ? state.pageB : state.pageA;
  const lang = fromA ? INITIAL_APPEARANCE_A.lang : INITIAL_APPEARANCE_B.lang;
  const text = fromA ? state.textA : state.textB;
  const position = fromA ? STICKY_POSITION_A_PX : STICKY_POSITION_B_PX;
  const card = await createSticky(source, lang, text, position);
  if (fromA) state.cardA = card;
  await Promise.all([waitForText(source, text), waitForText(target, text)]);
  return { text };
}

async function waitForCardRemoved(page, card) {
  const handle = await page.waitForFunction((element) => !element.isConnected, card, {
    timeout: UNDO_SETTLE_TIMEOUT_MS,
  });
  await handle.dispose();
}

async function undoUntilRemoved(state) {
  for (let count = FIRST_PRESS_COUNT; count <= UNDO_PRESS_LIMIT; count += 1) {
    await state.pageA.keyboard.press(SHORTCUT_UNDO_KEY);
    try {
      await waitForCardRemoved(state.pageA, state.cardA);
      return count;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      state.undoWaits.push({ pressCount: count, message: errorMessage(error) });
    }
  }
  throw new Error(`A sticky still exists after ${UNDO_PRESS_LIMIT} undo presses.`);
}

async function checkUndo(state) {
  if (!state.syncedA || !state.syncedB) throw new Error('Both sync checks must pass before undo.');
  state.undoWaits = [];
  state.undoPresses = await undoUntilRemoved(state);
  await Promise.all([
    waitForText(state.pageA, state.textA, 'hidden'), waitForText(state.pageB, state.textA, 'hidden'),
    waitForText(state.pageA, state.textB), waitForText(state.pageB, state.textB),
  ]);
  return { undoPresses: state.undoPresses, intermediateWaits: state.undoWaits };
}

async function checkRedo(state) {
  if (!state.undone) throw new Error('Undo must pass before redo.');
  for (let count = 0; count < state.undoPresses; count += 1) {
    await state.pageA.keyboard.press(SHORTCUT_REDO_KEY);
  }
  await Promise.all([
    waitForText(state.pageA, state.textA), waitForText(state.pageB, state.textA),
    waitForText(state.pageA, state.textB), waitForText(state.pageB, state.textB),
  ]);
  return { redoPresses: state.undoPresses };
}

async function boardScreenshot(state, options, appearance, viewport, report, suffix = '') {
  if (!state.created) throw new Error('Board creation must pass before board screenshots.');
  await state.pageA.setViewportSize(viewport);
  await applyAppearance(state.pageA, appearance);
  await passNamePrompt(state.pageA, appearance.lang, PARTICIPANT_NAME_A);
  await dismissOpenPopovers(state.pageA);
  await state.pageA.getByTitle(LABELS[appearance.lang].undoTitle, { exact: true })
    .or(state.pageA.getByTitle(LABELS[appearance.lang].nothingToUndoTitle, { exact: true }))
    .first().waitFor();
  if (state.redone) await waitForText(state.pageA, state.textA);
  return captureScreenshot(state.pageA, `board-${appearance.lang}-${appearance.theme}${suffix}.png`, report, options.out);
}

async function checkScreenshots(state, options, report) {
  for (const appearance of APPEARANCES) {
    await runStep(report, `landing ${appearance.lang}/${appearance.theme}`,
      () => landingScreenshot(state.pageA, options, appearance, report));
  }
}

async function checkBoardScreenshots(state, options, report) {
  for (const appearance of APPEARANCES) {
    await runStep(report, `board ${appearance.lang}/${appearance.theme}`,
      () => boardScreenshot(state, options, appearance, VIEWPORT_DESKTOP, report));
  }
  await runStep(report, STEP_NAMES.narrow,
    () => boardScreenshot(state, options, APPEARANCES[0], VIEWPORT_NARROW, report, '-narrow'));
}

async function checkCollaboration(state, options, report) {
  state.created = await runStep(report, STEP_NAMES.create, () => createBoard(state.pageA, options, report));
  state.joined = await runStep(report, STEP_NAMES.join, () => joinBoard(state.pageB, report));
  state.syncedA = await runStep(report, STEP_NAMES.syncA, () => checkSync(state, SYNC_DIRECTION_A_TO_B));
  state.syncedB = await runStep(report, STEP_NAMES.syncB, () => checkSync(state, SYNC_DIRECTION_B_TO_A));
  state.undone = await runStep(report, STEP_NAMES.undo, () => checkUndo(state));
  state.redone = await runStep(report, STEP_NAMES.redo, () => checkRedo(state));
}

async function reportUnavailableChecks(report) {
  const names = [
    ...APPEARANCES.map(({ lang, theme }) => `landing ${lang}/${theme}`),
    STEP_NAMES.create, STEP_NAMES.join, STEP_NAMES.syncA, STEP_NAMES.syncB,
    STEP_NAMES.undo, STEP_NAMES.redo,
    ...APPEARANCES.map(({ lang, theme }) => `board ${lang}/${theme}`),
    STEP_NAMES.narrow,
  ];
  for (const name of names) {
    await runStep(report, name, () => {
      throw new Error('Not exercised: Chromium/context initialization failed; see launch two contexts.');
    });
  }
}

async function executeChecks(options, report) {
  const stamp = Date.now();
  const state = { textA: `sync-A-${stamp}`, textB: `sync-B-${stamp}` };
  const initialized = await runStep(report, STEP_NAMES.launch, async () => {
    const browserTempDir = join(options.out, 'browser-temp');
    await mkdir(browserTempDir, { recursive: true });
    process.env.TMPDIR = browserTempDir;
    const { chromium } = await loadPlaywright();
    state.browser = await chromium.launch({ headless: true });
    state.pageA = await createParticipant(state.browser, 'A', INITIAL_APPEARANCE_A, report);
    state.pageB = await createParticipant(state.browser, 'B', INITIAL_APPEARANCE_B, report);
  });
  try {
    if (!initialized) {
      await reportUnavailableChecks(report);
      return;
    }
    await checkScreenshots(state, options, report);
    await checkCollaboration(state, options, report);
    await checkBoardScreenshots(state, options, report);
  } finally {
    if (state.browser) await runStep(report, STEP_NAMES.close, () => state.browser.close());
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(NODE_ARGUMENT_OFFSET_COUNT));
  options.out = await prepareOutput(options.out);
  const report = {
    startedAt: new Date().toISOString(), baseUrl: options.baseUrl,
    strictConsole: options.strictConsole, boardUrl: null, steps: [], screenshots: [],
    consoleErrors: [], pageErrors: [],
  };
  await executeChecks(options, report);
  report.finishedAt = new Date().toISOString();
  const failedSteps = report.steps.filter((step) => !step.passed).length;
  report.summary = {
    passedSteps: report.steps.length - failedSteps, failedSteps,
    screenshots: report.screenshots.length, pageErrors: report.pageErrors.length,
    consoleErrors: report.consoleErrors.length,
    passed: failedSteps === 0 && report.pageErrors.length === 0
      && (!options.strictConsole || report.consoleErrors.length === 0),
  };
  const reportPath = join(options.out, REPORT_FILENAME);
  await writeFile(reportPath, `${JSON.stringify(report, null, JSON_INDENT_SPACES)}\n`);
  console.log(`${report.summary.passed ? 'PASS' : 'FAIL'}: ${report.summary.passedSteps}/${report.steps.length} steps; ${report.summary.screenshots} screenshots; ${report.summary.pageErrors} page errors; ${report.summary.consoleErrors} console errors; ${reportPath}`);
  process.exitCode = report.summary.passed ? EXIT_SUCCESS : EXIT_FAILURE;
}

main().catch((error) => {
  console.error(`UI live check failed: ${errorMessage(error)}`);
  process.exitCode = EXIT_FAILURE;
});
