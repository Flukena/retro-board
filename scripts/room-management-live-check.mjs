#!/usr/bin/env node
/**
 * Multi-context live check of the signed-in workspace and room management: the create menu, card thumbnails, search
 * and sort, rename and delete from a card, the deleted-room screen, the signed-in home hint, sign-out and the guest
 * room expiry, against the local fake Google, which this script runs in-process on FAKE_OIDC_PORT so a second
 * account can sign in. Start isolated servers first (free ports, never production ones or the repo .env):
 *   VITE_YJS_PORT=1270 npx vite --host localhost --port 5201 --strictPort
 *   YJS_ALLOW_INSECURE_HTTP=true YJS_PORT=1270 YJS_ROOM_CREATE_BURST=100 YJS_ROOM_CREATES_PER_HOUR=1000 \
 *     YJS_COLD_ROOM_OPEN_IP_BURST=100 YJS_COLD_ROOM_OPENS_PER_IP_PER_MINUTE=1000 \
 *     YJS_COLD_ROOM_OPEN_ROOM_BURST=100 YJS_COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE=1000 \
 *     YJS_GUEST_ROOM_RETENTION_MS=20000 YJS_GUEST_SWEEP_INTERVAL_MS=1000 \
 *     YJS_ALLOWED_ORIGINS=http://localhost:5201,http://127.0.0.1:5201 \
 *     YJS_DB_DIR=<out>/db YJS_UPLOADS_DIR=<out>/uploads \
 *     GOOGLE_OAUTH_ENDPOINT_BASE=http://127.0.0.1:4475 \
 *     GOOGLE_OAUTH_CLIENT_ID=dev-client GOOGLE_OAUTH_CLIENT_SECRET=dev-secret \
 *     GOOGLE_OAUTH_REDIRECT_URI=http://localhost:1270/api/auth/google/callback \
 *     node yjs-server.mjs > <out>/relay.log 2>&1
 *   YJS_PUBLIC_WALL=true YJS_PORT=1235 YJS_DB_DIR=<out>/public-db YJS_ALLOW_INSECURE_HTTP=true \
 *     YJS_ALLOWED_ORIGINS=http://localhost:5201,http://127.0.0.1:5201 node yjs-server.mjs > <out>/public-relay.log 2>&1
 * FAKE_OIDC_PORT=4475 YJS_GUEST_ROOM_RETENTION_MS=20000 node scripts/room-management-live-check.mjs http://localhost:5201 <out>
 * Vite proxies the Public Wall to port 1235. The guest expiry step reads the sweep line from <out>/relay.log, so the
 * relay must log there; the retention must match the relay's. Every context shares one IP, so the cold-room open
 * limits are raised as above; with the defaults the relay answers 429 to most reconnects. Start every run with an
 * empty db: the room counts are exact. Exits only through the caller's timeout if a server hangs.
 * A (English) signs in and owns the rooms; B (Thai) stays a guest; C (English) is a second Google account;
 * S is a signed-out browser that still holds the signed-in hint; G is a fresh guest.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE } from '../src/client/account/signed-in-hint.js';
import { MY_BOARDS_PATH } from '../src/client/account/my-boards-link.js';
import { HOME_HINT_CLASS } from '../src/client/app/home-view.js';
import { AGILE_GUIDE_PATH } from '../src/client/seo/seo-pages.js';
import { STARTER_FORMAT, starterFormat } from '../src/client/templates/starter-formats.js';
import { DELETE_COPY_KEYS } from '../src/client/workspace/room-delete-copy.js';
import { WORKSPACE_SORT } from '../src/client/workspace/workspace-model.js';
import { GUEST_ROOM_RETENTION_HOURS } from '../src/domain/room-retention.js';
import { ROOM_KIND } from '../src/domain/room-ownership.js';
import { MAINTENANCE_INTERVAL_MS } from '../src/server/relay-config.js';
import { FAKE_GOOGLE_PROFILE, startFakeGoogleOidc } from './fake-google-oidc.mjs';
import {
  BASE_LABELS, BOARD_URL_PATTERN, CANVAS_SELECTOR, FAKE_GOOGLE_DECISION, POKER_URL_PATTERN, REDO_KEY, SYNC_TIMEOUT_MS,
  UNDO_KEY, VIEWPORT, addSharedSticky, appLabel, createBlankBoardFromMenu, createLockedBoard, createMenuItem, createMenuNameField,
  createMenuTrigger, enter,
  escapeRegExp, openCreateMenu, openLanding, openWorkspace, participant, runLiveCheck, secondTab, shot, signInLink, step,
  undoUntilHidden, unlockScreen, visitStub, waitForTextOn, workspaceHeading,
} from './board-live-helpers.mjs';

const ACCOUNT_C = Object.freeze({ sub: 'fake-google-sub-c', email: 'second.user@example.com', name: 'Second User' });
const NAME = Object.freeze({ a: 'Ada', b: 'บี' });
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const ROOMS_API_PATH = '/api/account/rooms';
const STICKY_B_PX = { x: 900, y: 420 };
// Clear of the minimap (bottom right) and the tool dock.
const EMPTY_CANVAS_PX = { x: 640, y: 480 };
const PHONE_VIEWPORT = Object.freeze({ width: 390, height: 844 });
const POLL_MS = 1_000;
const stamp = Date.now();
const SPRINT_NUMBER_RANGE = 1000;
const sprint = stamp % SPRINT_NUMBER_RANGE;
const TITLE = Object.freeze({
  board: `Sprint ${sprint} Retro`, renamed: `Sprint ${sprint} Review`,
  locked1: 'Locked one', locked2: 'Locked two', locked3: 'Locked three',
});
const STICKY_B_TEXT = `guest-B-${stamp}`;
const NO_MATCH_QUERY = `no-such-board-${stamp}`;
// Test-only password, generated per run and kept in memory.
const PASSWORD_BYTES = 9;
const LOCKED_PASSWORD = `rm-${randomBytes(PASSWORD_BYTES).toString('base64url')}`;
const GUEST_SWEEP_LINE = /\[yjs\] guest room sweep \{ retired: ([1-9]\d*)/;
const TEMPLATE_SLUG = STARTER_FORMAT.START_STOP_CONTINUE;
// Controller ruling (Task 7 review I1(b)): the landing shows well inside the CSS reveal fallback, so the fallback
// cannot be what reveals it. Counted from the sign-out click, or from domcontentloaded for a reload.
const LANDING_SWITCH_LIMIT_MS = 1_000;
const MS_PER_SECOND = 1_000;
const REVEAL_DELAY_PROPERTY = '--home-hint-reveal-delay';
// How long a click on the locked board's disabled Rename gets to (wrongly) open the rename dialog.
const NO_DIALOG_SETTLE_MS = 500;
// Workspace DOM (Workspace.jsx, WorkspaceCard.jsx); thumbnails are aria-hidden, so they are found by class.
const CARD_SELECTOR = '.rb-workspace-card:not(.rb-workspace-card--skeleton)';
const CARD_LINK_SELECTOR = '.rb-workspace-card__link';
const NOTICE_SELECTOR = '.rb-workspace__notice';
const THUMB = Object.freeze({
  zoneRects: '.rb-workspace-card__thumb--zones svg rect',
  lock: '.rb-workspace-card__thumb--locked svg',
  pokerCards: '.rb-workspace-card__thumb--poker .rb-workspace-card__poker-card',
  empty: '.rb-workspace-card__thumb--empty',
});
// A list preview zone carries geometry and colour only (sorted key names).
const PREVIEW_ZONE_KEYS = Object.freeze(['color', 'h', 'w', 'x', 'y']);
const HOME_WATCH_SELECTORS = Object.freeze({
  landing: '.rb-landing__page', title: '#workspace-title', notice: NOTICE_SELECTOR, hintClass: HOME_HINT_CLASS,
});

function requiredEnvInt(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be set to match the relay (see the header).`);
  return value;
}

const OIDC_PORT = requiredEnvInt('FAKE_OIDC_PORT');
const GUEST_RETENTION_MS = requiredEnvInt('YJS_GUEST_ROOM_RETENTION_MS');
// The sweep runs on the relay's maintenance tick: the room must first outlive its retention, then a tick must fire.
const GUEST_SWEEP_WAIT_MS = GUEST_RETENTION_MS + 2 * MAINTENANCE_INTERVAL_MS;
const TICK_MARGIN_MS = 5_000;
// Long enough after B creates its room for at least one sweep to run while the room is past retention but in use.
const IN_USE_WINDOW_MS = GUEST_RETENTION_MS + MAINTENANCE_INTERVAL_MS + TICK_MARGIN_MS;

const codeOfHref = (href) => href.split('#')[0].split('/').pop();
const codeOf = (url) => codeOfHref(new URL(url).pathname);
const exactText = (text) => new RegExp(`^${escapeRegExp(text)}$`);
const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));
const templateName = (lang) => appLabel(lang, starterFormat(TEMPLATE_SLUG).nameKey);
const templateZoneTitles = (lang) => starterFormat(TEMPLATE_SLUG).columns.map((column) => appLabel(lang, column.zoneKey));

// ---------- page handles ----------

const accountTrigger = (page, lang = 'en') => page.getByRole('button', { name: appLabel(lang, 'account.menu'), exact: true });
const cards = (page) => page.locator(CARD_SELECTOR);
const cardOf = (page, code) => cards(page).filter({ has: page.locator(`${CARD_LINK_SELECTOR}[href*="/${code}#"]`) });
const topBarTitle = (page) => page.locator('.rb-topbar-title');
const deletedHeading = (page, lang, key) => page.getByRole('heading', { name: appLabel(lang, key), exact: true });
const landingCreate = (page, lang) => page.getByRole('button', { name: BASE_LABELS[lang].create, exact: true });
const isFocused = (locator) => locator.evaluate((node) => node === document.activeElement);
const templateChip = (menu, lang) => menu.getByRole('button', { name: appLabel(lang, 'tpl.start', { name: templateName(lang) }), exact: true });
const storedHint = (page) => page.evaluate((key) => localStorage.getItem(key), SIGNED_IN_HINT_KEY);

/** The deleted screen shows its heading and exactly one link home. */
async function expectDeletedScreen(page, lang, key) {
  await deletedHeading(page, lang, key).waitFor();
  assert.equal(await page.locator('a[href="/"]').count(), 1, `${lang} deleted screen has one home link`);
}
const guestNote = (page, lang) => page.getByText(appLabel(lang, 'landing.guestNote', { hours: GUEST_ROOM_RETENTION_HOURS }), { exact: true });

async function expectSignedIn(page, name) {
  await accountTrigger(page).getByText(name, { exact: true }).waitFor();
}

/** The codes of the workspace cards, in the order they show. */
const cardCodes = (page) => page.locator(CARD_LINK_SELECTOR)
  .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))
  .then((hrefs) => hrefs.map(codeOfHref));

/** Waits until the workspace shows exactly `codes`, in that order (search and sort re-render asynchronously). */
const waitForCardOrder = (page, codes) => page.waitForFunction(({ selector, expected }) => {
  const actual = [...document.querySelectorAll(selector)].map((node) => node.getAttribute('href').split('#')[0].split('/').pop());
  return actual.length === expected.length && actual.every((code, index) => code === expected[index]);
}, { selector: CARD_LINK_SELECTOR, expected: codes }, { timeout: SYNC_TIMEOUT_MS });

/** Opens the workspace fresh, so its list comes from the relay, and fails on any error notice (for example a 429). */
async function openList(page, baseUrl) {
  await openWorkspace(page, baseUrl);
  assert.deepEqual(await page.locator(NOTICE_SELECTOR).allTextContents(), [], 'the workspace shows no error notice');
}

/** Opens a card's ⋯ menu; `name` is the card's name (the code for locked and Poker rooms). */
async function openCardMenu(page, lang, code, name) {
  const options = appLabel(lang, 'workspace.card.options', { title: name });
  await cardOf(page, code).getByRole('button', { name: options, exact: true }).click();
  const menu = cardOf(page, code).getByRole('menu', { name: options, exact: true });
  await menu.waitFor();
  return menu;
}

/** Whether nothing covers the dialog panel: its corners and centre are topmost. */
const dialogPanelOnTop = (dialog) => dialog.evaluate((node) => {
  const INSET_PX = 4;
  const box = node.firstElementChild.getBoundingClientRect();
  const points = [
    [box.left + INSET_PX, box.top + INSET_PX], [box.right - INSET_PX, box.top + INSET_PX],
    [box.left + INSET_PX, box.bottom - INSET_PX], [box.right - INSET_PX, box.bottom - INSET_PX],
    [box.left + box.width / 2, box.top + box.height / 2],
  ];
  return points.every(([x, y]) => node.contains(document.elementFromPoint(x, y)));
});

async function waitForTitle(pages, title) {
  await Promise.all(pages.map((page) => topBarTitle(page).filter({ hasText: exactText(title) }).waitFor({ timeout: SYNC_TIMEOUT_MS })));
}

/** Stores the UI language for the page's next load. */
const storeLanguage = (page, lang) => page.evaluate((value) => localStorage.setItem('rb_lang', value), lang);

async function setLanguage(page, lang) {
  await storeLanguage(page, lang);
  await page.reload();
}

/** A guest's board, from the landing page. */
async function createGuestBoard(page, baseUrl, lang, name) {
  await openLanding(page, baseUrl);
  await landingCreate(page, lang).click();
  await page.waitForURL(BOARD_URL_PATTERN);
  await enter(page, lang, name);
  return page.url();
}

/** Enters a Poker room, answering the name prompt when it asks. */
async function joinPoker(page, lang, name) {
  const prompt = page.getByPlaceholder(appLabel(lang, 'name.placeholder'), { exact: true });
  const players = page.locator('.rb-poker-players');
  await prompt.or(players).first().waitFor();
  if (await prompt.isVisible()) {
    await prompt.fill(name);
    await page.getByRole('button', { name: appLabel(lang, 'name.confirm'), exact: true }).click();
  }
  await players.waitFor();
}

async function waitForTemplateZones(page, lang) {
  await Promise.all(templateZoneTitles(lang).map((title) => page.getByText(title, { exact: true }).waitFor({ timeout: SYNC_TIMEOUT_MS })));
}

// ---------- create menu ----------

async function createBlankFromMenu(page, lang, title) {
  const url = await createBlankBoardFromMenu(page, lang, title);
  await enter(page, lang, NAME.a);
  await waitForTitle([page], title);
  return url;
}

/** The creator's browser lays out the starter zones once the room has synced; the card preview reads those zones. */
async function createTemplateFromMenu(page, lang) {
  const menu = await openCreateMenu(page, lang);
  await createMenuItem(menu, lang, 'workspace.create.template').click();
  await templateChip(menu, lang).click();
  await page.waitForURL(BOARD_URL_PATTERN);
  await enter(page, lang, NAME.a);
  await waitForTemplateZones(page, lang);
  return page.url();
}

async function createPokerFromMenu(page, lang) {
  const menu = await openCreateMenu(page, lang);
  await createMenuItem(menu, lang, 'workspace.create.poker').click();
  await page.waitForURL(POKER_URL_PATTERN);
  await joinPoker(page, lang, NAME.a);
  return page.url();
}

async function createLockedFromMenu(page, baseUrl) {
  const url = await createLockedBoard(page, baseUrl, LOCKED_PASSWORD);
  await unlockScreen(page, 'en', LOCKED_PASSWORD, NAME.a);
  return url;
}

/** Runs `create` from the open workspace and checks the relay then lists exactly one more room: the new one. */
async function createsOneRoom(page, baseUrl, create) {
  const before = await cardCodes(page);
  const url = await create();
  await openList(page, baseUrl);
  const after = await cardCodes(page);
  assert.deepEqual(after.filter((code) => !before.includes(code)), [codeOf(url)], 'the new room is the only one added');
  assert.equal(after.length, before.length + 1, 'exactly one room is added');
  return url;
}

/** Opens the create menu, moves focus into it with `focusInside`, presses Escape; true when focus is on the trigger. */
async function escapeReturnsFocus(page, lang, focusInside) {
  const menu = await openCreateMenu(page, lang);
  await focusInside(menu);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  return isFocused(createMenuTrigger(page, lang));
}

/** With the Blank panel open and its field focused, the trigger closes the menu; true when focus is on the trigger. */
async function triggerClosesOpenPanel(page, lang) {
  const menu = await openCreateMenu(page, lang);
  await createMenuItem(menu, lang, 'workspace.create.new').click();
  await createMenuNameField(menu, lang).click();
  await createMenuTrigger(page, lang).click();
  await menu.waitFor({ state: 'detached' });
  return isFocused(createMenuTrigger(page, lang));
}

/** Collapses the Blank panel through its own item and reports where focus is (recorded, not asserted: Task 6 M1). */
async function focusAfterCollapsingPanel(page, lang) {
  const menu = await openCreateMenu(page, lang);
  const blank = createMenuItem(menu, lang, 'workspace.create.new');
  await blank.click();
  await createMenuNameField(menu, lang).click();
  await blank.click();
  await createMenuNameField(menu, lang).waitFor({ state: 'detached' });
  const focus = { onItem: await isFocused(blank), onTrigger: await isFocused(createMenuTrigger(page, lang)) };
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  return focus;
}

async function createMenuFocus(page, lang) {
  const returned = {
    escapeFromItem: await escapeReturnsFocus(page, lang, (menu) => createMenuItem(menu, lang, 'workspace.create.new').focus()),
    escapeFromNameField: await escapeReturnsFocus(page, lang, async (menu) => {
      await createMenuItem(menu, lang, 'workspace.create.new').click();
      await createMenuNameField(menu, lang).focus();
    }),
    escapeFromTemplateChip: await escapeReturnsFocus(page, lang, async (menu) => {
      await createMenuItem(menu, lang, 'workspace.create.template').click();
      await templateChip(menu, lang).focus();
    }),
    triggerClosesOpenPanel: await triggerClosesOpenPanel(page, lang),
  };
  for (const [check, onTrigger] of Object.entries(returned)) assert.equal(onTrigger, true, `${check}: focus returns to the create trigger`);
  return { returned, collapsedPanel: await focusAfterCollapsingPanel(page, lang) };
}

const insideHorizontally = (box, viewport) => box.x >= 0 && box.x + box.width <= viewport.width;
const insideViewport = (box, viewport) => insideHorizontally(box, viewport) && box.y >= 0 && box.y + box.height <= viewport.height;

/** Screenshots the open create menu, then its locked panel, and measures both against the viewport. */
async function createMenuLayout(page, lang, viewport, size, report) {
  const menu = await openCreateMenu(page, lang);
  const closedPanel = await menu.boundingBox();
  await shot(page, `create-menu-${size}.png`, report);
  await createMenuItem(menu, lang, 'workspace.create.locked').click();
  await menu.getByRole('form', { name: appLabel(lang, 'roomLock.create.toggle'), exact: true }).waitFor();
  const lockedPanel = await menu.boundingBox();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  await shot(page, `create-menu-locked-${size}.png`, report);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.ok(insideViewport(closedPanel, viewport), `${size}: the create menu lies inside the viewport`);
  assert.ok(insideHorizontally(lockedPanel, viewport), `${size}: the locked panel stays inside the viewport's width`);
  assert.ok(scrollWidth <= viewport.width, `${size}: no horizontal scroll`);
  return { closedPanel, lockedPanel, scrollWidth };
}

/** The three-card workspace and its create menu at one size. */
async function workspaceShots(page, lang, viewport, report) {
  await page.setViewportSize(viewport);
  const size = `${lang}-${viewport.width}`;
  await shot(page, `workspace-three-cards-${size}.png`, report);
  return createMenuLayout(page, lang, viewport, size, report);
}

// ---------- cards ----------

async function cardThumbnails(page, rooms) {
  const template = cardOf(page, rooms.template);
  return {
    templateRects: await template.locator(THUMB.zoneRects).count(),
    templateText: await template.textContent(),
    templateName: await template.getByRole('heading').textContent(),
    lockIcons: await cardOf(page, rooms.locked).locator(THUMB.lock).count(),
    lockedBadge: await cardOf(page, rooms.locked).getByText(appLabel('en', 'workspace.badge.locked'), { exact: true }).count(),
    lockedName: await cardOf(page, rooms.locked).getByRole('heading').textContent(),
    pokerCards: await cardOf(page, rooms.poker).locator(THUMB.pokerCards).allTextContents(),
    pokerName: await cardOf(page, rooms.poker).getByRole('heading').textContent(),
    blankThumb: await cardOf(page, rooms.blank).locator(THUMB.empty).textContent(),
  };
}

function assertThumbnails(seen, rooms) {
  const zoneTitles = templateZoneTitles('en');
  assert.ok(seen.templateRects >= zoneTitles.length, `the template card draws its ${zoneTitles.length} zones`);
  assert.ok(zoneTitles.every((title) => !seen.templateText.includes(title)), 'the template card shows no zone title');
  assert.equal(seen.lockIcons, 1, 'the locked card shows the lock thumbnail');
  assert.equal(seen.lockedBadge, 1, 'the locked card has its badge');
  assert.equal(seen.lockedName, rooms.locked, 'a locked card is named by its code');
  assert.ok(seen.pokerCards.length > 0, 'the Poker card shows the Poker thumbnail');
  assert.equal(seen.pokerName, appLabel('en', 'workspace.card.poker', { code: rooms.poker }));
  assert.equal(seen.blankThumb, appLabel('en', 'workspace.card.noZones'), 'the blank board has no zones to draw');
}

/** A request from `page` straight to the relay, with that page's account cookie; resolves to its status and raw body. */
const relayRequest = (page, path, init = {}) => page.evaluate(async (request) => {
  const { getRelayHttpBaseUrl } = await import('/src/client/session/room-session.js');
  const response = await fetch(`${getRelayHttpBaseUrl()}${request.path}`, { ...request.init, credentials: 'include' });
  return { status: response.status, body: await response.text() };
}, { path, init });

/** The relay's own list for the signed-in page. */
const relayList = (page) => relayRequest(page, ROOMS_API_PATH);

/** A forged room request from another account's page, with that account's own cookie. */
const forgedStatus = async (page, code, action, body) => (await relayRequest(page, `${ROOMS_API_PATH}/${code}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).status;

/** The list answer carries each template zone's geometry and colour only, and no zone title. */
function assertPreviewPrivacy({ status, body }, rooms) {
  assert.equal(status, HTTP_OK);
  assert.ok(templateZoneTitles('en').every((title) => !body.includes(title)), 'no zone title leaves the relay');
  const listed = JSON.parse(body).rooms;
  assert.deepEqual(sorted(listed.map((room) => room.code)), sorted(Object.values(rooms)));
  const { zones } = listed.find((room) => room.code === rooms.template).preview;
  assert.equal(zones.length, templateZoneTitles('en').length);
  assert.ok(zones.every((zone) => sorted(Object.keys(zone)).join() === PREVIEW_ZONE_KEYS.join()), 'preview zones hold geometry and colour only');
  for (const code of [rooms.locked, rooms.poker]) assert.equal(listed.find((room) => room.code === code).preview, null);
  return { rooms: listed.length, templateZones: zones.length };
}

/** Name A–Z as the spec states it: the language's collation, ties broken by code. */
const byName = (named, locale) => [...named]
  .sort((left, right) => left.name.localeCompare(right.name, locale) || (left.code < right.code ? -1 : Number(left.code > right.code)))
  .map((room) => room.code);

/** Deletes `code` from its card through the type-to-confirm step; screenshots the confirm step, and the open menu if asked. */
async function deleteFromCard(page, lang, { code, name, kind, shotName, menuShotName, report }) {
  const copy = DELETE_COPY_KEYS[kind];
  const menu = await openCardMenu(page, lang, code, name);
  if (menuShotName) await shot(page, menuShotName, report);
  // The entry names the room kind, as its dialog does.
  await menu.getByRole('menuitem', { name: appLabel(lang, copy.menu), exact: true }).click();
  const confirm = page.getByRole('dialog', { name: appLabel(lang, copy.title), exact: true });
  await confirm.getByText(appLabel(lang, copy.prompt, { code }), { exact: true }).waitFor();
  await confirm.getByRole('textbox').fill(code);
  assert.equal(await dialogPanelOnTop(confirm), true, 'nothing covers the confirm dialog');
  await shot(page, shotName, report);
  await confirm.getByRole('button', { name: appLabel(lang, 'common.delete'), exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await cardOf(page, code).waitFor({ state: 'detached' });
}

async function renameFromDialog(page, lang, title) {
  const dialog = page.getByRole('dialog', { name: appLabel(lang, 'myBoards.renameTitle'), exact: true });
  await dialog.getByRole('textbox').fill(title);
  await dialog.getByRole('button', { name: appLabel(lang, 'common.save'), exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** The owner's More → Rename board on a locked board. */
async function renameLockedBoard(page, title) {
  await page.getByTitle(BASE_LABELS.en.more, { exact: true }).click();
  await page.getByText(appLabel('en', 'roomLock.menu.rename'), { exact: true }).click();
  await renameFromDialog(page, 'en', title);
}

async function pressOnBoard(page, key) {
  await page.locator(CANVAS_SELECTOR).click({ position: EMPTY_CANVAS_PX });
  await page.keyboard.press(key);
}

/** Opens the account menu and waits for its Sign out item, so a missing item is not just a menu still opening. */
async function openAccountMenu(page, lang) {
  await accountTrigger(page, lang).click();
  const menu = page.locator('.rb-account').getByRole('menu');
  await menu.getByRole('button', { name: appLabel(lang, 'account.signOut'), exact: true }).waitFor();
  return menu;
}

const myBoardsLink = (menu, lang) => menu.getByRole('link', { name: appLabel(lang, 'account.myBoards'), exact: true });

// ---------- signed-in hint ----------

/**
 * Init script: records, in ms since the page's navigation start, the landing's state at domcontentloaded and when
 * the landing first shows, the workspace heading appears and the workspace notice appears.
 */
function watchHome(selectors) {
  const watch = { dcl: null, landingVisibleAt: null, workspaceAt: null, noticeAt: null };
  window.rbHomeWatch = watch;
  const landingState = () => {
    const landing = document.querySelector(selectors.landing);
    return landing ? getComputedStyle(landing).visibility : 'absent';
  };
  const record = () => {
    const now = performance.now();
    if (watch.landingVisibleAt === null && landingState() === 'visible') watch.landingVisibleAt = now;
    if (watch.workspaceAt === null && document.querySelector(selectors.title)) watch.workspaceAt = now;
    if (watch.noticeAt === null && document.querySelector(selectors.notice)) watch.noticeAt = now;
  };
  new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true });
  document.addEventListener('DOMContentLoaded', () => {
    watch.dcl = {
      at: performance.now(), hinted: document.documentElement.classList.contains(selectors.hintClass), landing: landingState(),
    };
    record();
  });
}

const homeWatch = (page) => page.evaluate(() => window.rbHomeWatch);

/** The CSS reveal fallback's delay (home.css), read from the page. */
async function revealDelayMs(page) {
  const value = (await page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name), REVEAL_DELAY_PROPERTY)).trim();
  const ms = value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * MS_PER_SECOND;
  assert.ok(Number.isFinite(ms) && ms > 0, `${REVEAL_DELAY_PROPERTY} is set (${value})`);
  return ms;
}

async function watchedPage(browser, lang, report, name) {
  const page = await participant(browser, lang, report, name);
  report.pages.push(page);
  await page.addInitScript(watchHome, HOME_WATCH_SELECTORS);
  return page;
}

/** A tab of A's context with the home watcher installed. */
async function watchedTab(page, report, name) {
  const tab = await secondTab(page, report, name);
  await tab.addInitScript(watchHome, HOME_WATCH_SELECTORS);
  return tab;
}

/** The signed-out landing at one size. */
async function landingShot(page, lang, viewport, report) {
  await page.setViewportSize(viewport);
  await landingCreate(page, lang).waitFor();
  await shot(page, `landing-signed-out-${lang}-${viewport.width}.png`, report);
}

/** Byte length of the relay log now, so later reads only see lines written after this moment. */
const logSize = async (path) => (await stat(path)).size;

async function logSince(path, offset) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    await file.read(buffer, 0, buffer.length, offset);
    return buffer.toString('utf8');
  } finally {
    await file.close();
  }
}

async function waitForGuestSweep(path, offset) {
  const deadline = Date.now() + GUEST_SWEEP_WAIT_MS;
  while (Date.now() < deadline) {
    const match = GUEST_SWEEP_LINE.exec(await logSince(path, offset));
    if (match) return Number(match[1]);
    await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
  }
  throw new Error(`no guest room sweep within ${GUEST_SWEEP_WAIT_MS} ms`);
}

// ---------- scenario ----------

async function setup(browser, baseUrl, report) {
  const a = await participant(browser, 'en', report, 'A');
  const b = await participant(browser, 'th', report, 'B');
  report.pages.push(a, b);
  return { a, b };
}

async function signInSteps({ a, b, report, baseUrl, state }) {
  await step(report, '1. A signs in and lands on an empty workspace with the hint set; B (guest, th) sees the guest note and creates a board', async () => {
    await openLanding(a, baseUrl);
    await visitStub(a, baseUrl, FAKE_GOOGLE_DECISION.APPROVE);
    await openList(a, baseUrl);
    await expectSignedIn(a, FAKE_GOOGLE_PROFILE.name);
    await a.getByRole('heading', { name: appLabel('en', 'workspace.empty.title'), exact: true }).waitFor();
    assert.equal(await a.locator(HOME_WATCH_SELECTORS.landing).count(), 0, 'no landing for a signed-in person');
    assert.equal(await guestNote(a, 'en').count(), 0, 'no guest note once signed in');
    assert.equal(await storedHint(a), SIGNED_IN_HINT_VALUE, 'the signed-in hint is stored');
    await shot(a, 'workspace-empty-en.png', report);
    state.aBoard = await secondTab(a, report, 'A-board');
    await openLanding(b, baseUrl);
    await guestNote(b, 'th').waitFor();
    await shot(b, 'landing-guest-note-th.png', report);
    // B's own room stays open in its own tab until the expiry step, so the sweep cannot take it earlier.
    state.bOwn = b;
    state.guestUrl = await createGuestBoard(b, baseUrl, 'th', NAME.b);
    state.guestCreatedAt = Date.now();
    state.bGuest = await secondTab(b, report, 'B-guest');
    return { guest: codeOf(state.guestUrl) };
  });
  await step(report, '2. the account menu has no My boards on /, and on the agile guide a My boards link goes to /', async () => {
    const home = await openAccountMenu(a, 'en');
    assert.equal(await myBoardsLink(home, 'en').count(), 0, 'no My boards item on the home page');
    await a.keyboard.press('Escape');
    await a.goto(new URL(AGILE_GUIDE_PATH, baseUrl).href);
    const link = myBoardsLink(await openAccountMenu(a, 'en'), 'en');
    const href = await link.getAttribute('href');
    assert.equal(href, MY_BOARDS_PATH);
    await link.click();
    await a.waitForURL((url) => url.pathname === MY_BOARDS_PATH);
    await workspaceHeading(a).waitFor();
    return { guideLink: href };
  });
}

async function createSteps({ a, report, baseUrl, state }) {
  await step(report, '3. create menu: Escape and closing with a panel open return focus to the trigger; Blank, template, Poker and locked each add one room', async () => {
    await openList(a, baseUrl);
    const focus = await createMenuFocus(a, 'en');
    state.boardUrl = await createsOneRoom(a, baseUrl, () => createBlankFromMenu(a, 'en', TITLE.board));
    state.templateUrl = await createsOneRoom(a, baseUrl, () => createTemplateFromMenu(a, 'en'));
    state.pokerUrl = await createsOneRoom(a, baseUrl, () => createPokerFromMenu(a, 'en'));
    state.lockedUrl = await createsOneRoom(a, baseUrl, () => createLockedFromMenu(a, baseUrl));
    state.rooms = Object.freeze({
      blank: codeOf(state.boardUrl), template: codeOf(state.templateUrl), poker: codeOf(state.pokerUrl), locked: codeOf(state.lockedUrl),
    });
    return { focus, rooms: state.rooms };
  });
  await step(report, '4. the cards show the right thumbnails, and the relay list carries zone geometry only', async () => {
    const seen = await cardThumbnails(a, state.rooms);
    assertThumbnails(seen, state.rooms);
    state.templateName = seen.templateName;
    await shot(a, 'workspace-four-cards-en.png', report);
    return { ...seen, relay: assertPreviewPrivacy(await relayList(a), state.rooms) };
  });
}

async function renameSearchDeleteSteps({ a, report, baseUrl, state }) {
  const { aBoard, bGuest, rooms } = state;
  await step(report, '5. A renames the blank board from its card; B sees it live and B\'s undo/redo is unaffected', async () => {
    await aBoard.goto(state.boardUrl);
    await enter(aBoard, 'en', NAME.a);
    await bGuest.goto(state.boardUrl);
    await enter(bGuest, 'th', NAME.b);
    await waitForTitle([bGuest, aBoard], TITLE.board);
    await addSharedSticky(bGuest, 'th', STICKY_B_TEXT, STICKY_B_PX);
    await waitForTextOn([aBoard, bGuest], STICKY_B_TEXT);
    const menu = await openCardMenu(a, 'en', rooms.blank, TITLE.board);
    await menu.getByRole('menuitem', { name: appLabel('en', 'myBoards.rename'), exact: true }).click();
    await renameFromDialog(a, 'en', TITLE.renamed);
    await cardOf(a, rooms.blank).getByRole('heading', { name: TITLE.renamed, exact: true }).waitFor();
    await waitForTitle([bGuest, aBoard], TITLE.renamed);
    await shot(bGuest, 'renamed-live-th.png', report);
    const presses = await undoUntilHidden(bGuest, STICKY_B_TEXT);
    await waitForTextOn([aBoard, bGuest], STICKY_B_TEXT, 'hidden');
    await waitForTitle([bGuest, aBoard], TITLE.renamed);
    for (let count = 0; count < presses; count += 1) await bGuest.keyboard.press(REDO_KEY);
    await waitForTextOn([aBoard, bGuest], STICKY_B_TEXT);
    await waitForTitle([bGuest, aBoard], TITLE.renamed);
    await openList(a, baseUrl);
    await cardOf(a, rooms.blank).getByRole('heading', { name: TITLE.renamed, exact: true }).waitFor();
    return { undoPresses: presses };
  });
  await step(report, '6. searching a code leaves one card; Newest and Name A–Z order the cards as specified', async () => {
    const search = a.getByRole('searchbox', { name: appLabel('en', 'workspace.search'), exact: true });
    await search.fill(rooms.template);
    await waitForCardOrder(a, [rooms.template]);
    await search.fill(NO_MATCH_QUERY);
    await a.getByText(appLabel('en', 'workspace.noMatch'), { exact: true }).waitFor();
    await search.fill('');
    const sort = a.getByRole('combobox', { name: appLabel('en', 'workspace.sort'), exact: true });
    const recent = await cardCodes(a);
    // Created in this order in step 3, so Newest is the reverse.
    const newest = [rooms.locked, rooms.poker, rooms.template, rooms.blank];
    await sort.selectOption(WORKSPACE_SORT.CREATED);
    await waitForCardOrder(a, newest);
    const named = [
      { code: rooms.blank, name: TITLE.renamed }, { code: rooms.template, name: state.templateName },
      { code: rooms.poker, name: rooms.poker }, { code: rooms.locked, name: rooms.locked },
    ];
    const nameOrder = byName(named, 'en');
    await sort.selectOption(WORKSPACE_SORT.NAME);
    await waitForCardOrder(a, nameOrder);
    await sort.selectOption(WORKSPACE_SORT.RECENT);
    await waitForCardOrder(a, recent);
    return { recent, newest, nameOrder };
  });
  await step(report, '7. A deletes the blank board from its card while B is in it: deleted screen (th, en), link not found, gone from the list', async () => {
    await deleteFromCard(a, 'en', { code: rooms.blank, name: TITLE.renamed, kind: ROOM_KIND.BOARD, shotName: 'delete-confirm-en.png', report });
    await expectDeletedScreen(bGuest, 'th', 'roomDeleted.title.board');
    await expectDeletedScreen(aBoard, 'en', 'roomDeleted.title.board');
    await shot(bGuest, 'deleted-board-th.png', report);
    await shot(aBoard, 'deleted-board-en.png', report);
    await openLanding(bGuest, baseUrl);
    await bGuest.goto(state.boardUrl);
    await bGuest.getByText(appLabel('th', 'room.bootstrap.invalid.title'), { exact: true }).waitFor();
    await openList(a, baseUrl);
    assert.deepEqual(sorted(await cardCodes(a)), sorted([rooms.template, rooms.poker, rooms.locked]));
  });
}

async function threeCardSteps({ a, report, baseUrl, state }) {
  const { aBoard, bGuest, rooms } = state;
  await step(report, '8. three cards and the create menu in en and th at 1440×900 and 390×844; the menu stays inside the viewport', async () => {
    const layout = {};
    layout['en-1440'] = await workspaceShots(a, 'en', VIEWPORT, report);
    layout['en-390'] = await workspaceShots(a, 'en', PHONE_VIEWPORT, report);
    await storeLanguage(a, 'th');
    await openList(a, baseUrl);
    layout['th-390'] = await workspaceShots(a, 'th', PHONE_VIEWPORT, report);
    layout['th-1440'] = await workspaceShots(a, 'th', VIEWPORT, report);
    return layout;
  });
  await step(report, '9. A deletes the Poker room from its card (th UI) while B is in it; the Public Wall still opens for B', async () => {
    await bGuest.goto(state.pokerUrl);
    await joinPoker(bGuest, 'th', NAME.b);
    // A's whole context reads Thai since step 8 stored it, so A's own room tab is Thai too.
    await aBoard.goto(state.pokerUrl);
    await joinPoker(aBoard, 'th', NAME.a);
    await deleteFromCard(a, 'th', {
      code: rooms.poker, name: rooms.poker, kind: ROOM_KIND.POKER, shotName: 'delete-confirm-poker-th.png',
      menuShotName: 'card-menu-poker-th.png', report,
    });
    await expectDeletedScreen(bGuest, 'th', 'roomDeleted.title.poker');
    await expectDeletedScreen(aBoard, 'th', 'roomDeleted.title.poker');
    await shot(bGuest, 'deleted-poker-th.png', report);
    assert.deepEqual(sorted(await cardCodes(a)), sorted([rooms.template, rooms.locked]));
    await storeLanguage(a, 'en');
    await bGuest.getByRole('link', { name: appLabel('th', 'room.bootstrap.home'), exact: true }).click();
    await landingCreate(bGuest, 'th').waitFor();
    await bGuest.goto(new URL('/public', state.pokerUrl).href);
    await enter(bGuest, 'th', NAME.b);
    for (const key of ['roomDeleted.title.board', 'roomDeleted.title.poker']) {
      assert.equal(await deletedHeading(bGuest, 'th', key).count(), 0, 'the Public Wall is not marked deleted');
    }
    await shot(bGuest, 'public-wall-th.png', report);
  });
}

async function lockedSteps({ a, report, baseUrl, state }) {
  const { aBoard, bGuest, rooms } = state;
  await step(report, '10. the locked card has its badge and a disabled Rename with its hint; owner-menu renames undo/redo for both', async () => {
    await openList(a, baseUrl);
    const menu = await openCardMenu(a, 'en', rooms.locked, rooms.locked);
    const rename = menu.getByRole('menuitem', { name: appLabel('en', 'myBoards.rename'), exact: true });
    assert.equal(await rename.getAttribute('aria-disabled'), 'true', 'no relay rename for a locked board');
    await menu.getByText(appLabel('en', 'workspace.card.renameLocked'), { exact: true }).waitFor();
    await shot(a, 'workspace-locked-menu-en.png', report);
    // A real pointer click on the aria-disabled item; Playwright's actionability check would otherwise wait for it to enable.
    await rename.click({ force: true });
    await a.waitForTimeout(NO_DIALOG_SETTLE_MS);
    assert.equal(await a.getByRole('dialog', { name: appLabel('en', 'myBoards.renameTitle'), exact: true }).count(), 0, 'Rename opens no dialog');
    await a.keyboard.press('Escape');
    await aBoard.goto(state.lockedUrl);
    await unlockScreen(aBoard, 'en', LOCKED_PASSWORD, NAME.a);
    await bGuest.goto(state.lockedUrl);
    await unlockScreen(bGuest, 'th', LOCKED_PASSWORD, NAME.b);
    await renameLockedBoard(aBoard, TITLE.locked1);
    await waitForTitle([aBoard, bGuest], TITLE.locked1);
    await renameLockedBoard(aBoard, TITLE.locked2);
    await waitForTitle([aBoard, bGuest], TITLE.locked2);
    await pressOnBoard(aBoard, UNDO_KEY);
    await waitForTitle([aBoard, bGuest], TITLE.locked1);
    await pressOnBoard(aBoard, REDO_KEY);
    await waitForTitle([aBoard, bGuest], TITLE.locked2);
    await renameLockedBoard(aBoard, TITLE.locked3);
    await waitForTitle([aBoard, bGuest], TITLE.locked3);
    await pressOnBoard(aBoard, UNDO_KEY);
    await waitForTitle([aBoard, bGuest], TITLE.locked2);
    await shot(aBoard, 'locked-renamed-en.png', report);
  });
  await step(report, '11. A deletes the locked board from its card while B is in it: the deleted screen replaces the locked board', async () => {
    await openList(a, baseUrl);
    await deleteFromCard(a, 'en', {
      code: rooms.locked, name: rooms.locked, kind: ROOM_KIND.BOARD, shotName: 'delete-confirm-locked-en.png', report,
    });
    await expectDeletedScreen(bGuest, 'th', 'roomDeleted.title.board');
    await expectDeletedScreen(aBoard, 'en', 'roomDeleted.title.board');
    await shot(bGuest, 'deleted-locked-th.png', report);
    assert.deepEqual(await cardCodes(a), [rooms.template]);
  });
}

async function otherAccountStep({ a, report, browser, baseUrl, state, stub }) {
  await step(report, '12. a second account C sees an empty workspace; forged delete and rename of A\'s room → 404', async () => {
    const c = await participant(browser, 'en', report, 'C');
    report.pages.push(c);
    try {
      stub.useProfile(ACCOUNT_C);
      await openLanding(c, baseUrl);
      await visitStub(c, baseUrl, FAKE_GOOGLE_DECISION.APPROVE);
      await openList(c, baseUrl);
      await expectSignedIn(c, ACCOUNT_C.name);
      await c.getByRole('heading', { name: appLabel('en', 'workspace.empty.title'), exact: true }).waitFor();
      await shot(c, 'workspace-other-account-en.png', report);
      const keeper = state.rooms.template;
      const deleteStatus = await forgedStatus(c, keeper, 'delete', { confirmCode: keeper });
      const renameStatus = await forgedStatus(c, keeper, 'title', { title: 'forged' });
      assert.equal(deleteStatus, HTTP_NOT_FOUND);
      assert.equal(renameStatus, HTTP_NOT_FOUND);
      await openList(a, baseUrl);
      assert.deepEqual(await cardCodes(a), [keeper]);
      await cardOf(a, keeper).getByRole('heading', { name: state.templateName, exact: true }).waitFor();
      return { deleteStatus, renameStatus };
    } finally {
      stub.useProfile(FAKE_GOOGLE_PROFILE);
      await c.context().close();
    }
  });
}

async function guestExpiryStep({ a, report, baseUrl, state }) {
  await step(report, '13. guest expiry: B\'s idle room is swept, A\'s template board remains and opens from its card', async () => {
    const { bOwn, bGuest } = state;
    const relayLog = join(report.out, 'relay.log');
    // A sweep runs while B's room is past its retention but still open: a room in use is never swept.
    await bOwn.waitForTimeout(Math.max(0, state.guestCreatedAt + IN_USE_WINDOW_MS - Date.now()));
    assert.equal(GUEST_SWEEP_LINE.test(await logSince(relayLog, 0)), false, 'no guest room was swept while in use');
    await bOwn.locator(CANVAS_SELECTOR).waitFor();
    assert.equal(await deletedHeading(bOwn, 'th', 'roomDeleted.title.board').count(), 0);
    const offset = await logSize(relayLog);
    await bOwn.close();
    const retired = await waitForGuestSweep(relayLog, offset);
    await bGuest.goto(state.guestUrl);
    await bGuest.getByText(appLabel('th', 'room.bootstrap.invalid.title'), { exact: true }).waitFor();
    await shot(bGuest, 'guest-expired-th.png', report);
    await openList(a, baseUrl);
    assert.deepEqual(await cardCodes(a), [state.rooms.template]);
    await cardOf(a, state.rooms.template).locator(CARD_LINK_SELECTOR).click();
    await a.waitForURL(BOARD_URL_PATTERN);
    await enter(a, 'en', NAME.a);
    await waitForTemplateZones(a, 'en');
    return { retired };
  });
}

async function hintSteps({ a, report, baseUrl, state }) {
  await step(report, '14. a hinted reload of / never shows the landing and shows the workspace inside the reveal delay', async () => {
    const tab = await watchedTab(a, report, 'A-hint');
    state.hintTab = tab;
    await openList(tab, baseUrl);
    await tab.reload({ waitUntil: 'domcontentloaded' });
    await workspaceHeading(tab).waitFor();
    const watch = await homeWatch(tab);
    const delayMs = await revealDelayMs(tab);
    assert.notEqual(watch.dcl.landing, 'visible', 'the landing is absent or hidden at domcontentloaded');
    assert.equal(watch.landingVisibleAt, null, 'the landing never shows');
    assert.notEqual(watch.workspaceAt, null, 'the watcher saw the workspace');
    assert.ok(watch.workspaceAt < delayMs, `the workspace shows before the ${delayMs} ms reveal delay`);
    assert.equal(await tab.locator(HOME_WATCH_SELECTORS.landing).count(), 0);
    return { watch, revealDelayMs: delayMs };
  });
  await step(report, '15. A signs out from the workspace: / shows the landing within 1 s without a navigation and the hint is gone', async () => {
    const tab = state.hintTab;
    const url = tab.url();
    const clickedAt = await tab.evaluate(() => { window.rbSameDocument = true; return performance.now(); });
    const menu = await openAccountMenu(tab, 'en');
    await menu.getByRole('button', { name: appLabel('en', 'account.signOut'), exact: true }).click();
    await landingCreate(tab, 'en').waitFor();
    const watch = await homeWatch(tab);
    assert.notEqual(watch.landingVisibleAt, null, 'the watcher saw the landing');
    const switchMs = watch.landingVisibleAt - clickedAt;
    assert.ok(switchMs <= LANDING_SWITCH_LIMIT_MS, `the landing shows ${switchMs} ms after Sign out`);
    assert.equal(await tab.evaluate(() => window.rbSameDocument), true, 'no navigation');
    assert.equal(tab.url(), url);
    assert.equal(await storedHint(tab), null, 'sign-out clears the hint');
    await signInLink(tab, 'en').waitFor();
    await landingShot(tab, 'en', VIEWPORT, report);
    await landingShot(tab, 'en', PHONE_VIEWPORT, report);
    await setLanguage(tab, 'th');
    await landingShot(tab, 'th', PHONE_VIEWPORT, report);
    await landingShot(tab, 'th', VIEWPORT, report);
    return { switchMs, sessionEndedNoticeSeen: watch.noticeAt !== null };
  });
}

async function signedOutSteps({ report, browser, baseUrl }) {
  await step(report, '16. a stale hint in a signed-out browser falls back to the landing within 1 s of domcontentloaded', async () => {
    const s = await watchedPage(browser, 'en', report, 'S');
    try {
      await openLanding(s, baseUrl);
      await s.evaluate(([key, value]) => localStorage.setItem(key, value), [SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE]);
      await s.reload({ waitUntil: 'domcontentloaded' });
      await landingCreate(s, 'en').waitFor();
      const watch = await homeWatch(s);
      // React may mount, and drop the head script's mark, before domcontentloaded; the workspace showing proves the hint too.
      assert.ok(watch.dcl.hinted || watch.workspaceAt !== null, 'the stale hint took effect');
      assert.notEqual(watch.landingVisibleAt, null, 'the watcher saw the landing');
      const switchMs = watch.landingVisibleAt - watch.dcl.at;
      assert.ok(switchMs <= LANDING_SWITCH_LIMIT_MS, `the landing shows ${switchMs} ms after domcontentloaded`);
      // Recorded, not asserted: whether the workspace or its "session ended" notice flashed first (Task 7 M2 is parked).
      return {
        switchMs, watch, workspaceFlashed: watch.workspaceAt !== null, sessionEndedNoticeSeen: watch.noticeAt !== null,
        hintAfter: await storedHint(s),
      };
    } finally {
      await s.context().close();
    }
  });
  await step(report, '17. a fresh guest sees the unchanged landing', async () => {
    const g = await watchedPage(browser, 'en', report, 'G');
    try {
      await openLanding(g, baseUrl);
      await signInLink(g, 'en').waitFor();
      await guestNote(g, 'en').waitFor();
      const watch = await homeWatch(g);
      assert.equal(watch.dcl.hinted, false, 'no hint for a guest');
      assert.equal(watch.workspaceAt, null, 'no workspace for a guest');
      assert.equal(await storedHint(g), null);
      await shot(g, 'landing-guest-en.png', report);
      return { watch };
    } finally {
      await g.context().close();
    }
  });
  await step(report, '18. no page errors in any context', async () => {
    assert.deepEqual(report.pageErrors, []);
    return { consoleErrors: report.consoleErrors.length };
  });
}

const stub = await startFakeGoogleOidc({ port: OIDC_PORT });
try {
  await runLiveCheck('room-management-live-check.mjs', async (context) => {
    const state = {};
    const scenario = { ...context, state, stub };
    await signInSteps(scenario);
    await createSteps(scenario);
    await renameSearchDeleteSteps(scenario);
    await threeCardSteps(scenario);
    await lockedSteps(scenario);
    await otherAccountStep(scenario);
    await guestExpiryStep(scenario);
    await hintSteps(scenario);
    await signedOutSteps(scenario);
  }, { setup });
} finally {
  await stub.close();
}
