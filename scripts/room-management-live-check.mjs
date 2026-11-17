#!/usr/bin/env node
/**
 * Multi-context live check of room management: My boards (list, rename, delete), the deleted-room screen and the
 * guest room expiry, against the local fake Google, which this script runs in-process on FAKE_OIDC_PORT so a second
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
 * limits are raised as above; with the defaults the relay answers 429 to most reconnects. Exits only through the caller's timeout if a server hangs.
 * A (English) signs in and owns the rooms; B (Thai) stays a guest; C (English) is a second Google account.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setLang, t } from '../src/client/ui/i18n.js';
import { GUEST_ROOM_RETENTION_HOURS } from '../src/domain/room-retention.js';
import { MAINTENANCE_INTERVAL_MS } from '../src/server/relay-config.js';
import { FAKE_GOOGLE_PROFILE, startFakeGoogleOidc } from './fake-google-oidc.mjs';
import {
  BASE_LABELS, BOARD_URL_PATTERN, CANVAS_SELECTOR, FAKE_GOOGLE_DECISION, POKER_URL_PATTERN, REDO_KEY, SYNC_TIMEOUT_MS,
  UNDO_KEY, addSharedSticky, createLockedBoard, enter, openLanding, participant, runLiveCheck,
  secondTab, shot, step, undoUntilHidden, unlockScreen, visitStub, waitForTextOn,
} from './board-live-helpers.mjs';

const ACCOUNT_C = Object.freeze({ sub: 'fake-google-sub-c', email: 'second.user@example.com', name: 'Second User' });
const NAME = Object.freeze({ a: 'Ada', b: 'บี' });
const HTTP_NOT_FOUND = 404;
const STICKY_B_PX = { x: 900, y: 420 };
// Clear of the minimap (bottom right) and the tool dock.
const EMPTY_CANVAS_PX = { x: 640, y: 480 };
const POLL_MS = 1_000;
const stamp = Date.now();
const SPRINT_NUMBER_RANGE = 1000;
const sprint = stamp % SPRINT_NUMBER_RANGE;
const TITLE = Object.freeze({
  board: `Sprint ${sprint} Retro`, renamed: `Sprint ${sprint} Review`, keeper: 'Keeper board',
  locked1: 'Locked one', locked2: 'Locked two', locked3: 'Locked three',
});
const STICKY_B_TEXT = `guest-B-${stamp}`;
// Test-only password, generated per run and kept in memory.
const PASSWORD_BYTES = 9;
const LOCKED_PASSWORD = `rm-${randomBytes(PASSWORD_BYTES).toString('base64url')}`;
const GUEST_SWEEP_LINE = /\[yjs\] guest room sweep \{ retired: ([1-9]\d*)/;

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

/** Text in `lang`, from the app's own dictionary. */
function label(lang, key, params) {
  setLang(lang);
  return t(key, params);
}

const codeOf = (url) => new URL(url).pathname.split('/').pop();
const exactText = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

// ---------- page handles ----------

const accountTrigger = (page, lang = 'en') => page.getByRole('button', { name: label(lang, 'account.menu'), exact: true });
const myBoardsDialog = (page, lang) => page.getByRole('dialog', { name: label(lang, 'account.myBoards'), exact: true });
const boardRows = (page) => page.locator('.rb-my-boards__row');
const rowOf = (page, code) => boardRows(page).filter({ hasText: code });
const topBarTitle = (page) => page.locator('.rb-topbar-title');
const deletedHeading = (page, lang, key) => page.getByRole('heading', { name: label(lang, key), exact: true });

/** The deleted screen shows its heading and exactly one link home. */
async function expectDeletedScreen(page, lang, key) {
  await deletedHeading(page, lang, key).waitFor();
  assert.equal(await page.locator('a[href="/"]').count(), 1, `${lang} deleted screen has one home link`);
}
const guestNote = (page, lang) => page.getByText(label(lang, 'landing.guestNote', { hours: GUEST_ROOM_RETENTION_HOURS }), { exact: true });

async function expectSignedIn(page, name) {
  await accountTrigger(page).getByText(name, { exact: true }).waitFor();
}

/** Opens My boards from a fresh landing page, so the list comes from the relay. */
async function openMyBoards(page, lang) {
  await openLanding(page, new URL('/', page.url()).href);
  await accountTrigger(page, lang).click();
  await page.getByRole('button', { name: label(lang, 'account.myBoards'), exact: true }).click();
  const dialog = myBoardsDialog(page, lang);
  await dialog.waitFor();
  await dialog.getByText(label(lang, 'myBoards.loading'), { exact: true }).waitFor({ state: 'hidden' });
  return dialog;
}

/** The codes My boards lists, read from each row's Open link. */
async function listedCodes(page, lang) {
  const links = boardRows(page).getByRole('link', { name: label(lang, 'myBoards.open'), exact: true });
  return (await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).map((href) => href.split('#')[0].split('/').pop()).sort();
}

/**
 * Whether the dialog lies above everything: its panel's corners and centre are topmost, and on the landing page the
 * sticky public bar sits under the dialog's overlay. `bar` is null on pages without that bar.
 */
const dialogLayering = (dialog) => dialog.evaluate((node) => {
  const INSET_PX = 4;
  const pointsOf = (box) => [
    [box.left + INSET_PX, box.top + INSET_PX], [box.right - INSET_PX, box.top + INSET_PX],
    [box.left + INSET_PX, box.bottom - INSET_PX], [box.right - INSET_PX, box.bottom - INSET_PX],
    [box.left + box.width / 2, box.top + box.height / 2],
  ];
  const onTop = (box) => pointsOf(box).every(([x, y]) => node.contains(document.elementFromPoint(x, y)));
  const bar = document.querySelector('.rb-landing__public-bar');
  return { panel: onTop(node.firstElementChild.getBoundingClientRect()), bar: bar ? onTop(bar.getBoundingClientRect()) : null };
});

async function assertDialogOnTop(dialog, { landing }) {
  const layering = await dialogLayering(dialog);
  assert.equal(layering.panel, true, 'nothing covers the dialog panel');
  if (landing) assert.equal(layering.bar, true, 'the sticky public bar is under the dialog overlay');
  return layering;
}

async function waitForTitle(pages, title) {
  await Promise.all(pages.map((page) => topBarTitle(page).filter({ hasText: exactText(title) }).waitFor({ timeout: SYNC_TIMEOUT_MS })));
}

async function setLanguage(page, lang) {
  await page.evaluate((value) => localStorage.setItem('rb_lang', value), lang);
  await page.reload();
}

async function createBoard(page, baseUrl, lang, title, name) {
  await openLanding(page, baseUrl);
  if (title) await page.getByPlaceholder(label(lang, 'landing.create.namePlaceholder'), { exact: true }).fill(title);
  await page.getByRole('button', { name: BASE_LABELS[lang].create, exact: true }).click();
  await page.waitForURL(BOARD_URL_PATTERN);
  await enter(page, lang, name);
  return page.url();
}

/** Enters a Poker room, answering the name prompt when it asks. */
async function joinPoker(page, lang, name) {
  const prompt = page.getByPlaceholder(label(lang, 'name.placeholder'), { exact: true });
  const players = page.locator('.rb-poker-players');
  await prompt.or(players).first().waitFor();
  if (await prompt.isVisible()) {
    await prompt.fill(name);
    await page.getByRole('button', { name: label(lang, 'name.confirm'), exact: true }).click();
  }
  await players.waitFor();
}

async function createPoker(page, baseUrl, name) {
  await page.goto(new URL('/planning-poker', baseUrl).href);
  await page.getByRole('button', { name: label('en', 'landing.poker.btn'), exact: true }).click();
  await page.waitForURL(POKER_URL_PATTERN);
  await joinPoker(page, 'en', name);
  return page.url();
}

/** Deletes `code` from an open My boards dialog through the type-to-confirm step; screenshots the confirm step. */
async function deleteFromMyBoards(page, lang, { code, titleKey, promptKey, shotName, report }) {
  await rowOf(page, code).getByRole('button', { name: label(lang, 'common.delete'), exact: true }).click();
  const confirm = page.getByRole('dialog', { name: label(lang, titleKey), exact: true });
  await confirm.getByText(label(lang, promptKey, { code }), { exact: true }).waitFor();
  await confirm.getByRole('textbox').fill(code);
  await assertDialogOnTop(confirm, { landing: true });
  await shot(page, shotName, report);
  await confirm.getByRole('button', { name: label(lang, 'common.delete'), exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await rowOf(page, code).waitFor({ state: 'detached' });
}

async function renameFromDialog(page, lang, title) {
  const dialog = page.getByRole('dialog', { name: label(lang, 'myBoards.renameTitle'), exact: true });
  await dialog.getByRole('textbox').fill(title);
  await dialog.getByRole('button', { name: label(lang, 'common.save'), exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** The owner's More → Rename board on a locked board. */
async function renameLockedBoard(page, title) {
  await page.getByTitle(BASE_LABELS.en.more, { exact: true }).click();
  await page.getByText(label('en', 'roomLock.menu.rename'), { exact: true }).click();
  await renameFromDialog(page, 'en', title);
}

async function pressOnBoard(page, key) {
  await page.locator(CANVAS_SELECTOR).click({ position: EMPTY_CANVAS_PX });
  await page.keyboard.press(key);
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

async function createSteps({ a, b, report, baseUrl, state }) {
  await step(report, '1. A (signed in, en) creates a board and a Poker room; B (guest, th) creates a board', async () => {
    await openLanding(a, baseUrl);
    await visitStub(a, baseUrl, FAKE_GOOGLE_DECISION.APPROVE);
    await expectSignedIn(a, FAKE_GOOGLE_PROFILE.name);
    assert.equal(await guestNote(a, 'en').count(), 0, 'no guest note once signed in');
    await shot(a, 'landing-signed-in-en.png', report);
    state.aBoard = await secondTab(a, report, 'A-board');
    state.boardUrl = await createBoard(state.aBoard, baseUrl, 'en', TITLE.board, NAME.a);
    state.pokerUrl = await createPoker(state.aBoard, baseUrl, NAME.a);
    await openLanding(b, baseUrl);
    await guestNote(b, 'th').waitFor();
    await shot(b, 'landing-guest-note-th.png', report);
    // B's own room stays open in its own tab until the expiry step, so the sweep cannot take it earlier.
    state.bOwn = b;
    state.guestUrl = await createBoard(b, baseUrl, 'th', null, NAME.b);
    state.guestCreatedAt = Date.now();
    state.bGuest = await secondTab(b, report, 'B-guest');
    return { board: codeOf(state.boardUrl), poker: codeOf(state.pokerUrl), guest: codeOf(state.guestUrl) };
  });
  await step(report, '2. My boards lists exactly A\'s two rooms, uncovered by the landing bar; B\'s room is absent', async () => {
    const dialog = await openMyBoards(a, 'en');
    const codes = await listedCodes(a, 'en');
    assert.deepEqual(codes, [codeOf(state.boardUrl), codeOf(state.pokerUrl)].sort());
    assert.ok(!codes.includes(codeOf(state.guestUrl)), 'the guest room is not listed');
    const layering = await assertDialogOnTop(dialog, { landing: true });
    await shot(a, 'my-boards-en.png', report);
    return { codes, layering };
  });
}

async function renameAndDeleteSteps({ a, report, state }) {
  const { aBoard, bGuest } = state;
  await step(report, '3. A renames the board from My boards; B sees it live and B\'s undo/redo is unaffected', async () => {
    await aBoard.goto(state.boardUrl);
    await enter(aBoard, 'en', NAME.a);
    await bGuest.goto(state.boardUrl);
    await enter(bGuest, 'th', NAME.b);
    await waitForTitle([bGuest, aBoard], TITLE.board);
    await addSharedSticky(bGuest, 'th', STICKY_B_TEXT, STICKY_B_PX);
    await waitForTextOn([aBoard, bGuest], STICKY_B_TEXT);
    await rowOf(a, codeOf(state.boardUrl)).getByRole('button', { name: label('en', 'myBoards.rename'), exact: true }).click();
    await renameFromDialog(a, 'en', TITLE.renamed);
    await rowOf(a, codeOf(state.boardUrl)).getByText(TITLE.renamed, { exact: true }).waitFor();
    await waitForTitle([bGuest, aBoard], TITLE.renamed);
    await shot(bGuest, 'renamed-live-th.png', report);
    const presses = await undoUntilHidden(bGuest, STICKY_B_TEXT);
    await waitForTextOn([aBoard, bGuest], STICKY_B_TEXT, 'hidden');
    await waitForTitle([bGuest, aBoard], TITLE.renamed);
    for (let count = 0; count < presses; count += 1) await bGuest.keyboard.press(REDO_KEY);
    await waitForTextOn([aBoard, bGuest], STICKY_B_TEXT);
    await waitForTitle([bGuest, aBoard], TITLE.renamed);
    await openMyBoards(a, 'en');
    await rowOf(a, codeOf(state.boardUrl)).getByText(TITLE.renamed, { exact: true }).waitFor();
    return { undoPresses: presses };
  });
  await step(report, '4a. A deletes the board while B is in it: deleted screen (th, en), link not found, gone from the list', async () => {
    await deleteFromMyBoards(a, 'en', { code: codeOf(state.boardUrl), titleKey: 'myBoards.deleteTitle', promptKey: 'myBoards.deletePrompt', shotName: 'delete-confirm-en.png', report });
    await expectDeletedScreen(bGuest, 'th', 'roomDeleted.title.board');
    await expectDeletedScreen(aBoard, 'en', 'roomDeleted.title.board');
    await shot(bGuest, 'deleted-board-th.png', report);
    await shot(aBoard, 'deleted-board-en.png', report);
    await openLanding(bGuest, new URL('/', state.boardUrl).href);
    await bGuest.goto(state.boardUrl);
    await bGuest.getByText(label('th', 'room.bootstrap.invalid.title'), { exact: true }).waitFor();
    await openMyBoards(a, 'en');
    assert.deepEqual(await listedCodes(a, 'en'), [codeOf(state.pokerUrl)]);
  });
  await step(report, '4b. A deletes the Poker room (th UI) while B is in it; the Public Wall still opens for B', async () => {
    await bGuest.goto(state.pokerUrl);
    await joinPoker(bGuest, 'th', NAME.b);
    await aBoard.goto(state.pokerUrl);
    await joinPoker(aBoard, 'en', NAME.a);
    await setLanguage(a, 'th');
    const dialog = await openMyBoards(a, 'th');
    await assertDialogOnTop(dialog, { landing: true });
    await shot(a, 'my-boards-th.png', report);
    await deleteFromMyBoards(a, 'th', { code: codeOf(state.pokerUrl), titleKey: 'myBoards.deleteTitlePoker', promptKey: 'myBoards.deletePromptPoker', shotName: 'delete-confirm-poker-th.png', report });
    await expectDeletedScreen(bGuest, 'th', 'roomDeleted.title.poker');
    await shot(bGuest, 'deleted-poker-th.png', report);
    await myBoardsDialog(a, 'th').getByText(label('th', 'myBoards.empty'), { exact: true }).waitFor();
    await setLanguage(a, 'en');
    await bGuest.getByRole('link', { name: label('th', 'room.bootstrap.home'), exact: true }).click();
    await bGuest.getByRole('button', { name: BASE_LABELS.th.create, exact: true }).waitFor();
    await bGuest.goto(new URL('/public', state.pokerUrl).href);
    await enter(bGuest, 'th', NAME.b);
    for (const key of ['roomDeleted.title.board', 'roomDeleted.title.poker']) {
      assert.equal(await deletedHeading(bGuest, 'th', key).count(), 0, 'the Public Wall is not marked deleted');
    }
    await shot(bGuest, 'public-wall-th.png', report);
  });
}

async function lockedSteps({ a, report, baseUrl, state }) {
  const { aBoard, bGuest } = state;
  await step(report, '6. a locked board is listed with its badge and renamed from the owner menu with undo/redo', async () => {
    state.keeperUrl = await createBoard(aBoard, baseUrl, 'en', TITLE.keeper, NAME.a);
    state.lockedUrl = await createLockedBoard(aBoard, baseUrl, LOCKED_PASSWORD);
    await unlockScreen(aBoard, 'en', LOCKED_PASSWORD, NAME.a);
    await openMyBoards(a, 'en');
    const lockedRow = rowOf(a, codeOf(state.lockedUrl));
    await lockedRow.getByText(label('en', 'myBoards.locked'), { exact: true }).waitFor();
    assert.equal(await lockedRow.getByRole('button', { name: label('en', 'myBoards.rename'), exact: true }).count(), 0, 'no relay rename for a locked board');
    await shot(a, 'my-boards-locked-en.png', report);
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
  await step(report, '4c. A deletes the locked board while B is in it: deleted screen replaces the locked board', async () => {
    await openMyBoards(a, 'en');
    await deleteFromMyBoards(a, 'en', { code: codeOf(state.lockedUrl), titleKey: 'myBoards.deleteTitle', promptKey: 'myBoards.deletePrompt', shotName: 'delete-confirm-locked-en.png', report });
    await expectDeletedScreen(bGuest, 'th', 'roomDeleted.title.board');
    await expectDeletedScreen(aBoard, 'en', 'roomDeleted.title.board');
    await shot(bGuest, 'deleted-locked-th.png', report);
    assert.deepEqual(await listedCodes(a, 'en'), [codeOf(state.keeperUrl)]);
  });
}

/** A forged My boards request from C's page, with C's own account cookie. */
const forgedStatus = (page, code, action, body) => page.evaluate(async (request) => {
  const { getRelayHttpBaseUrl } = await import('/src/client/session/room-session.js');
  const response = await fetch(`${getRelayHttpBaseUrl()}/api/account/rooms/${request.code}/${request.action}`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body),
  });
  return response.status;
}, { code, action, body });

async function otherAccountStep({ a, report, browser, baseUrl, state, stub }) {
  await step(report, '5. a second account C sees none of A\'s rooms; forged delete and rename of A\'s room → 404', async () => {
    const c = await participant(browser, 'en', report, 'C');
    report.pages.push(c);
    try {
      stub.useProfile(ACCOUNT_C);
      await openLanding(c, baseUrl);
      await visitStub(c, baseUrl, FAKE_GOOGLE_DECISION.APPROVE);
      await expectSignedIn(c, ACCOUNT_C.name);
      const dialog = await openMyBoards(c, 'en');
      await dialog.getByText(label('en', 'myBoards.empty'), { exact: true }).waitFor();
      await shot(c, 'my-boards-other-account-en.png', report);
      const keeper = codeOf(state.keeperUrl);
      const deleteStatus = await forgedStatus(c, keeper, 'delete', { confirmCode: keeper });
      const renameStatus = await forgedStatus(c, keeper, 'title', { title: 'forged' });
      assert.equal(deleteStatus, HTTP_NOT_FOUND);
      assert.equal(renameStatus, HTTP_NOT_FOUND);
      await openMyBoards(a, 'en');
      assert.deepEqual(await listedCodes(a, 'en'), [keeper]);
      await rowOf(a, keeper).getByText(TITLE.keeper, { exact: true }).waitFor();
      return { deleteStatus, renameStatus };
    } finally {
      stub.useProfile(FAKE_GOOGLE_PROFILE);
      await c.context().close();
    }
  });
}

async function guestExpiryStep({ a, report, state }) {
  await step(report, '8. guest expiry: B\'s idle room is swept, A\'s room remains', async () => {
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
    await bGuest.getByText(label('th', 'room.bootstrap.invalid.title'), { exact: true }).waitFor();
    await shot(bGuest, 'guest-expired-th.png', report);
    await openMyBoards(a, 'en');
    assert.deepEqual(await listedCodes(a, 'en'), [codeOf(state.keeperUrl)]);
    await rowOf(a, codeOf(state.keeperUrl)).getByRole('link', { name: label('en', 'myBoards.open'), exact: true }).click();
    await enter(a, 'en', NAME.a);
    await waitForTitle([a], TITLE.keeper);
    return { retired };
  });
}

const stub = await startFakeGoogleOidc({ port: OIDC_PORT });
try {
  await runLiveCheck('room-management-live-check.mjs', async (context) => {
    const state = {};
    const scenario = { ...context, state, stub };
    await createSteps(scenario);
    await renameAndDeleteSteps(scenario);
    await lockedSteps(scenario);
    await otherAccountStep(scenario);
    await guestExpiryStep(scenario);
  }, { setup });
} finally {
  await stub.close();
}
