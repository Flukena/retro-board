// Shared Playwright helpers for two-participant board live checks
// (retro-outcomes-live-check.mjs, facilitation-live-check.mjs, account-live-check.mjs, room-lock-live-check.mjs,
// room-management-live-check.mjs).
import { formatLiveReport, redactRoomCapabilities } from './live-check-diagnostics.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setLang, t } from '../src/client/ui/i18n.js';

export const VIEWPORT = { width: 1440, height: 900 };
export const SYNC_TIMEOUT_MS = 15_000;
export const CANVAS_SELECTOR = '.rb-no-select';
const ACTION_TIMEOUT_MS = 15_000;
export const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
export const POKER_URL_PATTERN = /\/p\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
// PBKDF2 (600k iterations) runs on every unlock.
export const UNLOCK_TIMEOUT_MS = 30_000;
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

/** Text in `lang`, from the app's own dictionary. */
export function appLabel(lang, key, params) {
  setLang(lang);
  return t(key, params);
}

export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORKSPACE_LANGS = Object.freeze(['en', 'th']);
// The workspace's skeleton list while the rooms load (Workspace.jsx).
const WORKSPACE_LOADING_SELECTOR = 'ul[aria-busy="true"]';

/** The workspace heading's name in either language; once there are rooms it ends with their count ("My boards 3"). */
export const workspaceHeadingName = () => new RegExp(
  `^(?:${WORKSPACE_LANGS.map((lang) => escapeRegExp(appLabel(lang, 'workspace.title'))).join('|')})(?: \\d+)?$`,
);

export const workspaceHeading = (page) => page.getByRole('heading', { level: 1, name: workspaceHeadingName() });

export async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_MODULE || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright');
  const entry = join(dir, 'index.mjs');
  if (!existsSync(entry)) throw new Error(`Playwright missing at ${entry}`);
  return import(pathToFileURL(entry).href);
}

/** Gives a page the action timeout and the error capture every participant page has. */
function watchPage(page, report, name) {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.on('pageerror', error => report.pageErrors.push({ name, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ name, text: message.text(), url: message.location().url }); });
  return page;
}

export async function participant(browser, lang, report, name) {
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript((value) => {
    // A page the check sends to about:blank has an opaque origin, where localStorage throws.
    if (window.origin !== 'null' && !localStorage.getItem('rb_lang')) localStorage.setItem('rb_lang', value);
  }, lang);
  return watchPage(await context.newPage(), report, name);
}

/** Another tab of the same participant (same cookies and storage); failure screenshots include it. */
export async function secondTab(page, report, name) {
  const tab = watchPage(await page.context().newPage(), report, name);
  report.pages.push(tab);
  return tab;
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

/** Opens `/` as a signed-in person and waits until "My boards" (either language) has loaded its rooms. */
export async function openWorkspace(page, baseUrl) {
  await page.goto(new URL('/', baseUrl).href);
  await workspaceHeading(page).waitFor();
  await page.locator(WORKSPACE_LOADING_SELECTOR).waitFor({ state: 'detached' });
}

export const createMenuTrigger = (page, lang) => page.getByRole('button', { name: appLabel(lang, 'workspace.create'), exact: true });

/** Opens the workspace's create menu and returns it. */
export async function openCreateMenu(page, lang) {
  await createMenuTrigger(page, lang).click();
  const menu = page.getByRole('menu', { name: appLabel(lang, 'workspace.create'), exact: true });
  await menu.waitFor();
  return menu;
}

/** A create-menu entry by its title; the entry's accessible name continues with its description. */
export const createMenuItem = (menu, lang, titleKey) => menu.getByRole('menuitem', {
  name: new RegExp(`^${escapeRegExp(appLabel(lang, titleKey))}`),
});

export const createMenuNameField = (menu, lang) => menu.getByRole('textbox', { name: appLabel(lang, 'workspace.create.name'), exact: true });

/** Creates a blank board, named when `title` is given, from the open workspace's create menu; returns its link. */
export async function createBlankBoardFromMenu(page, lang, title = '') {
  const menu = await openCreateMenu(page, lang);
  await createMenuItem(menu, lang, 'workspace.create.new').click();
  if (title) await createMenuNameField(menu, lang).fill(title);
  await menu.getByRole('button', { name: appLabel(lang, 'workspace.create.submit'), exact: true }).click();
  await page.waitForURL(BOARD_URL_PATTERN);
  return page.url();
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

export const LOCK_LABELS = {
  en: {
    toggle: 'Create a password-protected board', password: 'Password', confirm: 'Confirm password',
    ack: 'If you forget the password nobody can recover the data, including the server owner',
    submit: 'Create protected board', promptTitle: 'This board is password-protected', unlock: 'Unlock board',
  },
  th: { promptTitle: 'บอร์ดนี้ป้องกันด้วยรหัสผ่าน', password: 'รหัสผ่าน', unlock: 'ปลดล็อกบอร์ด' },
};

export const passwordScreen = (page, lang) => page.getByRole('heading', { name: LOCK_LABELS[lang].promptTitle, exact: true });

/**
 * Creates a password-protected board from the signed-in workspace's create menu (English) and returns its link.
 * Only signed-in people may create one, and their home page is the workspace.
 */
export async function createLockedBoard(page, baseUrl, password) {
  await openWorkspace(page, baseUrl);
  const menu = await openCreateMenu(page, 'en');
  await createMenuItem(menu, 'en', 'workspace.create.locked').click();
  const form = page.getByRole('form', { name: LOCK_LABELS.en.toggle });
  await form.getByLabel(LOCK_LABELS.en.password, { exact: true }).fill(password);
  await form.getByLabel(LOCK_LABELS.en.confirm, { exact: true }).fill(password);
  await form.getByLabel(LOCK_LABELS.en.ack, { exact: true }).check();
  await form.getByRole('button', { name: LOCK_LABELS.en.submit, exact: true }).click();
  await page.waitForURL(BOARD_URL_PATTERN, { timeout: UNLOCK_TIMEOUT_MS });
  await passwordScreen(page, 'en').waitFor({ timeout: UNLOCK_TIMEOUT_MS });
  return page.url();
}

export async function submitPassword(scope, lang, password, submitLabel) {
  await scope.getByLabel(LOCK_LABELS[lang].password, { exact: true }).fill(password);
  await scope.getByRole('button', { name: submitLabel, exact: true }).click();
}

/** Unlocks the board's password screen, then enters the board as `name`. */
export async function unlockScreen(page, lang, password, name) {
  await passwordScreen(page, lang).waitFor({ timeout: UNLOCK_TIMEOUT_MS });
  await submitPassword(page, lang, password, LOCK_LABELS[lang].unlock);
  await passwordScreen(page, lang).waitFor({ state: 'hidden', timeout: UNLOCK_TIMEOUT_MS });
  await enter(page, lang, name);
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

// These checks emit each verdict immediately so a later timeout retains the last completed step.
export async function consoleStep(name, action, passedNames) {
  let result;
  try {
    result = await action();
  } catch (error) {
    console.log(`FAIL ${name}`);
    throw error;
  }
  passedNames?.push(name);
  console.log(`PASS ${name}`);
  return result;
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

// The two participants every two-context check uses: A writes English, B Thai.
export const NAME_A = 'Ada';
export const NAME_B = 'บี';
// Desktop and phone layouts every bottom-chrome check covers; `phone` ones use the phone layout's docked rows.
export const LAYOUT_VIEWPORTS = Object.freeze([
  { name: 'desktop-short', width: 1280, height: 600, phone: false },
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'phone-360', width: 360, height: 740, phone: true },
  { name: 'phone-320', width: 320, height: 568, phone: true },
  { name: 'phone-landscape', width: 740, height: 360, phone: true },
  { name: 'phone-landscape-short', width: 568, height: 320, phone: true },
]);

export const intersects = (one, other) => one.x < other.x + other.width && other.x < one.x + one.width
  && one.y < other.y + other.height && other.y < one.y + one.height;

/** The first match's box when it is shown, else null. */
export async function visibleBox(page, selector) {
  const locator = page.locator(selector).first();
  if (!await locator.count() || !await locator.isVisible()) return null;
  return locator.boundingBox();
}

// Intermediate mouse events per drag, so the board's drag handlers see a gesture rather than a jump.
export const DRAG_STEPS = 12;
const STICKY_SELECTOR = '[data-sticky-id]';

/** The board's canonical items, read through `window.storage` like the app's own sync; throws off a board. */
export async function boardItems(page) {
  return page.evaluate(async () => {
    const record = await window.storage.get('boardState', true);
    if (!record?.value) throw new Error('window.storage has no boardState; open a board first.');
    return record.value.items;
  });
}

export const itemById = (items, id) => items.find((item) => item.id === id);

export const boxCenter = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

export const withinPx = (actual, expected, tolerancePx) => Math.abs(actual - expected) <= tolerancePx;

/** The page box of the sticky whose element contains `text`; throws when no such sticky is shown. */
export async function stickyBox(page, text) {
  const box = await page.locator(STICKY_SELECTOR).filter({ hasText: text }).first().boundingBox();
  if (!box) throw new Error(`no sticky containing "${text}" is shown`);
  return box;
}

/**
 * Presses at `from` and moves by `by` in `steps` mouse events. The button is released in `finally`, so a failed step
 * never leaves a stuck drag; with `hold` it stays down after a completed move and the caller must `page.mouse.up()`.
 */
export async function dragBy(page, from, by, { steps = DRAG_STEPS, hold = false } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  let moved = false;
  try {
    await page.mouse.move(from.x + by.x, from.y + by.y, { steps });
    moved = true;
  } finally {
    if (!hold || !moved) await page.mouse.up();
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
    await enter(a, 'en', NAME_A);
    await b.goto(a.url());
    await enter(b, 'th', NAME_B);
    return { boardUrl: a.url() };
  });
  return { a, b };
}

/** A (English) signs in with the fake Google and creates a board locked with `password`; B (Thai) unlocks it. */
export async function lockedBoard(browser, baseUrl, report, password) {
  const a = await participant(browser, 'en', report, 'A');
  const b = await participant(browser, 'th', report, 'B');
  report.pages.push(a, b);
  await step(report, 'A signs in and creates a locked board; B unlocks it', async () => {
    await openLanding(a, baseUrl);
    await visitStub(a, baseUrl, FAKE_GOOGLE_DECISION.APPROVE);
    const boardUrl = await createLockedBoard(a, baseUrl, password);
    await unlockScreen(a, 'en', password, NAME_A);
    await b.goto(boardUrl);
    await unlockScreen(b, 'th', password, NAME_B);
    return { locked: true };
  });
  return { a, b };
}

export const LIVE_MODE = Object.freeze({ PLAIN: 'plain', LOCKED: 'locked' });

/** The check's mode from argv[4] (`plain` or `locked`). */
export function liveMode(argv = process.argv) {
  const mode = argv[4] ?? LIVE_MODE.PLAIN;
  if (!Object.values(LIVE_MODE).includes(mode)) throw new Error(`mode must be ${Object.values(LIVE_MODE).join(' or ')}`);
  return mode;
}

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const POLL_INTERVAL_MS = 100;

/** Polls `read` until `accept` holds for its value; fails with `message` and the last value after `timeoutMs`. */
export async function pollUntil(read, accept, message, timeoutMs = SYNC_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last)) {
    if (Date.now() > deadline) throw new Error(`${message}; last read ${JSON.stringify(last)}`);
    await sleep(POLL_INTERVAL_MS);
    last = await read();
  }
  return last;
}

/**
 * Waits until `editor` is focused with its caret after `current`. Opening an editor places the caret at the end of
 * its text 10 ms later (RetroBoard.jsx `beginFocus`); a select-all `fill` that lands first is collapsed by that move
 * and the new text is appended to the old instead of replacing it.
 */
export async function waitForEditorCaretAtEnd(editor, current) {
  const node = await editor.elementHandle();
  await editor.page().waitForFunction(
    ([target, expected]) => document.activeElement === target && target.value === expected
      && target.selectionStart === expected.length && target.selectionEnd === expected.length,
    [node, current],
  );
}

const RESOURCE_ERROR_PREFIX = 'Failed to load resource: the server responded with a status of ';
const ACCOUNT_PATH = '/api/account';
const ROOM_SESSION_PATH = '/api/room-session';

export function isExpectedBoardConsoleError({ url, text }, baseUrl, mode, relayOrigin = process.env.LIVE_CHECK_RELAY_ORIGIN) {
  const resource = URL.parse(url);
  if (!resource) return false;
  const app = new URL(baseUrl);
  // Standalone checks receive only the app URL. Vite's relay shares its host and uses a separate port.
  if (resource.protocol !== app.protocol || resource.hostname !== app.hostname) return false;
  if (relayOrigin && resource.origin !== relayOrigin) return false;
  if (resource.pathname === ACCOUNT_PATH) {
    const status = mode === LIVE_MODE.LOCKED ? '401 (Unauthorized)' : '404 (Not Found)';
    return text === RESOURCE_ERROR_PREFIX + status;
  }
  // Opening a locked room challenges the client before it supplies its unlock proof.
  return mode === LIVE_MODE.LOCKED && resource.pathname === ROOM_SESSION_PATH
    && text === RESOURCE_ERROR_PREFIX + '409 (Conflict)';
}

/** The final step records unexpected page and console errors on the isolated board. */
export async function errorsStep({ report }, mode) {
  await step(report, `${mode}: no page errors`, async () => {
    if (report.pageErrors.length) throw new Error(JSON.stringify(report.pageErrors));
    const unexpected = report.consoleErrors.filter(error => !isExpectedBoardConsoleError(error, report.baseUrl, mode));
    if (unexpected.length) throw new Error(`${unexpected.length} unexpected console error(s), see report.json`);
    return { consoleErrors: report.consoleErrors.length };
  });
}

/** The `runLiveCheck` options for `mode`: a locked board for `locked`, the default shared board otherwise. */
export const liveSetupFor = (mode, password) => (mode === LIVE_MODE.LOCKED
  ? { setup: (browser, baseUrl, report) => lockedBoard(browser, baseUrl, report, password) }
  : {});

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
    console.error(redactRoomCapabilities(`FAIL: ${error.message}`));
    process.exitCode = 1;
  } finally {
    await browser.close();
    const { pages, ...saved } = report;
    await writeFile(join(out, 'report.json'), formatLiveReport(saved));
    console.log(redactRoomCapabilities(report.steps.map(s => `${s.passed ? 'PASS' : 'FAIL'} ${s.name}`).join('\n')));
  }
}
