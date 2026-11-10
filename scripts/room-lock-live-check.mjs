#!/usr/bin/env node
/**
 * Two-context live check of password-protected end-to-end encrypted boards against the local fake Google.
 * Start isolated servers first (free ports, never production ones or the repo .env):
 *   FAKE_OIDC_PORT=4465 node scripts/fake-google-oidc.mjs
 *   VITE_YJS_PORT=1262 npx vite --host localhost --port 5196 --strictPort
 *   YJS_ALLOW_INSECURE_HTTP=true YJS_PORT=1262 YJS_ROOM_CREATE_BURST=100 YJS_ROOM_CREATES_PER_HOUR=1000 \
 *     YJS_ROOM_SESSION_TTL_SECONDS=60 \
 *     YJS_ALLOWED_ORIGINS=http://localhost:5196,http://127.0.0.1:5196 \
 *     YJS_DB_DIR=<out>/db YJS_UPLOADS_DIR=<out>/uploads \
 *     GOOGLE_OAUTH_ENDPOINT_BASE=http://127.0.0.1:4465 \
 *     GOOGLE_OAUTH_CLIENT_ID=dev-client GOOGLE_OAUTH_CLIENT_SECRET=dev-secret \
 *     GOOGLE_OAUTH_REDIRECT_URI=http://localhost:1262/api/auth/google/callback \
 *     node yjs-server.mjs > <out>/relay.log 2>&1
 * node scripts/room-lock-live-check.mjs http://localhost:5196 <out>
 * The 60 s session TTL (the relay's minimum) makes B's renewal, and so the re-unlock after a password
 * change, happen within about 48 s. The plaintext scan reads <out>/db and <out>/uploads, so the relay
 * must use exactly those directories.
 * A (English) signs in and creates the locked boards; B (Thai) stays a guest.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  BASE_LABELS, CANVAS_SELECTOR, FAKE_GOOGLE_DECISION, REDO_KEY, SYNC_TIMEOUT_MS, addSharedSticky, download, enter,
  openLanding, openMenu, participant, runLiveCheck, shot, step, undoUntilHidden, visitStub, waitForTextOn,
} from './board-live-helpers.mjs';

const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
// PBKDF2 (600k iterations) runs on every unlock; a rotation re-encrypts the board and its images.
const UNLOCK_TIMEOUT_MS = 30_000;
const ROTATE_TIMEOUT_MS = 90_000;
// TTL 60 s: the client renews 48 s after its last exchange; the margin covers a slow PBKDF2 and the round trip.
const RENEWAL_REUNLOCK_TIMEOUT_MS = 75_000;
const PERSIST_SETTLE_MS = 1_500;
const NAME_A = 'Ada';
const NAME_B = 'บี';
const STICKY_A_PX = { x: 420, y: 320 };
const STICKY_B_PX = { x: 900, y: 320 };
const STICKY_UNDO_PX = { x: 420, y: 600 };
const STICKY_PENDING_PX = { x: 900, y: 600 };
const STICKY_ROTATE_PX = { x: 660, y: 460 };
const STICKY_CONTROL_PX = { x: 600, y: 400 };
const DRAW_STROKE = Object.freeze({ from: { x: 300, y: 720 }, to: { x: 700, y: 780 }, steps: 12 });
const BYTE_WINDOW = 64;
const NOISE_IMAGE_PX = 96;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_RGB = 2;
const PNG_BIT_DEPTH = 8;
const RGB_CHANNELS = 3;
const SECRET_KEY_PATTERN = /authKey|wrappedDek|\bdek\b|roomKey|password/i;

const LABELS = {
  en: {
    lockToggle: 'Create a password-protected board', lockPassword: 'Password', lockConfirm: 'Confirm password',
    lockAck: 'If you forget the password nobody can recover the data, including the server owner',
    lockSubmit: 'Create protected board', promptTitle: 'This board is password-protected', password: 'Password',
    unlock: 'Unlock board', reunlockTitle: 'Enter the password again', reunlockSubmit: 'Continue',
    changePassword: 'Change board password', removeEveryone: 'Remove everyone (new key)',
    current: 'Current password', newPassword: 'New password', confirmNew: 'Confirm new password',
    changeSubmit: 'Change password', changed: 'Password changed. Others will be asked for the new password.',
    rotateSubmit: 'Remove everyone', exportZip: 'Export', import: 'Import', importOk: 'Overwrite',
  },
  th: {
    promptTitle: 'บอร์ดนี้ป้องกันด้วยรหัสผ่าน', password: 'รหัสผ่าน', unlock: 'ปลดล็อกบอร์ด',
    wrong: 'รหัสผ่านไม่ถูกต้อง ลองอีกครั้ง', reunlockTitle: 'ใส่รหัสผ่านอีกครั้ง', reunlockSubmit: 'ดำเนินการต่อ',
    changePassword: 'เปลี่ยนรหัสผ่านบอร์ด', removeEveryone: 'นำทุกคนออก (กุญแจใหม่)',
  },
};

// Test-only passwords, generated per run and kept in memory; the storage scan looks for exactly these.
const runSecret = (label) => `${label}-${randomBytes(9).toString('base64url')}`;
const PASSWORDS = Object.freeze({
  board1: runSecret('first'), board2: runSecret('second'), changed: runSecret('changed'), rotated: runSecret('rotated'),
});

// ---------- board state read through the page's own storage bridge ----------

const boardItems = (page) => page.evaluate(async () => (await window.storage.get('boardState', true))?.value?.items ?? []);
const itemText = (item) => (typeof item.text === 'string' ? item.text : '');

async function eventually(check, message, timeoutMs = SYNC_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => { setTimeout(resolve, 250); });
  }
  throw new Error(message);
}

const findItem = (page, predicate) => boardItems(page).then((items) => items.find(predicate) ?? null);
const e2eImageItems = (items) => items.filter((item) => item.type === 'image' && /\/e2e-blobs\//.test(item.src ?? ''));

/** Images on the canvas that decrypted into a blob: URL and decoded. */
const renderedBlobImages = (page) => page.locator(`${CANVAS_SELECTOR} img[src^="blob:"]`).evaluateAll(
  (nodes) => nodes.filter((node) => node.complete && node.naturalWidth > 0).map((node) => node.src),
);

async function waitForRenderedImages(page, count) {
  return eventually(async () => {
    const sources = await renderedBlobImages(page);
    return sources.length >= count ? sources : null;
  }, `expected ${count} decrypted images to render`);
}

/** Bytes behind a blob: URL in the page, i.e. the decrypted image the server must never see in clear. */
const blobBytes = async (page, url) => Buffer.from(await page.evaluate(async (source) => {
  const bytes = new Uint8Array(await (await fetch(source)).arrayBuffer());
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}, url), 'base64');

const middleWindow = (bytes) => {
  const start = Math.max(0, Math.floor(bytes.length / 2) - BYTE_WINDOW / 2);
  return bytes.subarray(start, start + BYTE_WINDOW);
};

// ---------- fixtures ----------

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A random-noise RGB PNG, so any window of its pixel data is unique to this run. */
function noisePng(size = NOISE_IMAGE_PX) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = PNG_BIT_DEPTH;
  header[9] = PNG_COLOR_RGB;
  const rowBytes = 1 + size * RGB_CHANNELS;
  const raw = randomBytes(rowBytes * size);
  for (let row = 0; row < size; row += 1) raw[row * rowBytes] = 0; // filter type None
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------- locked-board flows ----------

const passwordScreen = (page, lang) => page.getByRole('heading', { name: LABELS[lang].promptTitle, exact: true });
const reunlockDialog = (page, lang) => page.getByRole('dialog').filter({ has: page.getByText(LABELS[lang].reunlockTitle, { exact: true }) });

async function createLockedBoard(page, baseUrl, password) {
  await openLanding(page, baseUrl);
  await page.getByRole('button', { name: LABELS.en.lockToggle }).click();
  const form = page.getByRole('form', { name: LABELS.en.lockToggle });
  await form.getByLabel(LABELS.en.lockPassword, { exact: true }).fill(password);
  await form.getByLabel(LABELS.en.lockConfirm, { exact: true }).fill(password);
  await form.getByLabel(LABELS.en.lockAck, { exact: true }).check();
  await form.getByRole('button', { name: LABELS.en.lockSubmit, exact: true }).click();
  await page.waitForURL(BOARD_URL_PATTERN, { timeout: UNLOCK_TIMEOUT_MS });
  await passwordScreen(page, 'en').waitFor({ timeout: UNLOCK_TIMEOUT_MS });
  return page.url();
}

async function submitPassword(scope, lang, password, submitLabel) {
  await scope.getByLabel(LABELS[lang].password, { exact: true }).fill(password);
  await scope.getByRole('button', { name: submitLabel, exact: true }).click();
}

async function unlockScreen(page, lang, password, name) {
  await passwordScreen(page, lang).waitFor({ timeout: UNLOCK_TIMEOUT_MS });
  await submitPassword(page, lang, password, LABELS[lang].unlock);
  await passwordScreen(page, lang).waitFor({ state: 'hidden', timeout: UNLOCK_TIMEOUT_MS });
  await enter(page, lang, name);
}

async function reunlock(page, lang, password) {
  const dialog = reunlockDialog(page, lang);
  await submitPassword(dialog, lang, password, LABELS[lang].reunlockSubmit);
  await dialog.waitFor({ state: 'hidden', timeout: UNLOCK_TIMEOUT_MS });
}

async function openOwnerMenu(page, lang) {
  await page.getByTitle(BASE_LABELS[lang].more, { exact: true }).click();
  await page.getByText(LABELS[lang].changePassword, { exact: true }).waitFor();
  await page.getByText(LABELS[lang].removeEveryone, { exact: true }).waitFor();
}

/** Fills the owner's change-password or remove-everyone dialog and submits it. */
async function submitOwnerDialog(page, { menuLabel, current, next, submitLabel, timeout }) {
  await openOwnerMenu(page, 'en');
  await page.getByText(menuLabel, { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(LABELS.en.current, { exact: true }).fill(current);
  await dialog.getByLabel(LABELS.en.newPassword, { exact: true }).fill(next);
  await dialog.getByLabel(LABELS.en.confirmNew, { exact: true }).fill(next);
  await dialog.getByLabel(LABELS.en.lockAck, { exact: true }).check();
  await dialog.getByRole('button', { name: submitLabel, exact: true }).click();
  return dialog.getByRole('button', { name: submitLabel, exact: true }).waitFor({ state: 'hidden', timeout });
}

const CARET = Object.freeze({ START: 'start', END: 'end' });

/**
 * Opens the editor of the card showing `text` and puts the caret at its start or end.
 * The board moves the caret to the end a moment after focusing (RetroBoard beginFocus), so wait for
 * that first; placing the caret earlier is silently undone and both runs then type at the end.
 */
async function editCardAt(page, text, caret = CARET.END) {
  await page.getByText(text, { exact: true }).dblclick();
  await page.waitForFunction(() => {
    const field = document.activeElement;
    return field?.matches?.('textarea') && field.selectionStart === field.value.length;
  });
  const placed = await page.evaluate((atStart) => {
    const field = document.activeElement;
    const at = atStart ? 0 : field.value.length;
    field.setSelectionRange(at, at);
    return { at, start: field.selectionStart };
  }, caret === CARET.START);
  assert.equal(placed.start, placed.at, `caret placed at the ${caret} of "${text}"`);
}

// ---------- storage and disk scans ----------

/** Every key and value this origin keeps in localStorage, sessionStorage and IndexedDB, as text. */
const dumpBrowserStorage = (page) => page.evaluate(async () => {
  const fromStorage = (storage) => Object.keys(storage).map((key) => ({ key, value: storage.getItem(key) }));
  const toText = (value) => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer);
      return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    }
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const readStore = (db, name) => new Promise((resolve, reject) => {
    const request = db.transaction(name, 'readonly').objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result.map(toText));
    request.onerror = () => reject(request.error);
  });
  const indexed = [];
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const store of db.objectStoreNames) indexed.push({ database: name, store, values: await readStore(db, store) });
    db.close();
  }
  return { local: fromStorage(localStorage), session: fromStorage(sessionStorage), indexed };
});

/** The authKey this password derives for the open board, computed with the client's own module. */
async function deriveAuthKey(page, boardUrl, password) {
  return page.evaluate(async ({ url, secret }) => {
    const { pathname, hash } = new URL(url);
    const body = JSON.stringify({ code: pathname.split('/').pop(), token: hash.slice(1) });
    const { getRelayHttpBaseUrl } = await import('/src/client/session/room-session.js');
    const response = await fetch(`${getRelayHttpBaseUrl()}/api/room-session`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' }, body,
    });
    const { salt, kdf } = await response.json();
    const { deriveRoomSecrets } = await import('/src/client/room-lock/e2e-crypto.js');
    return (await deriveRoomSecrets(secret, salt, kdf)).authKey;
  }, { url: boardUrl, secret: password });
}

function secretHits(dump, secrets) {
  const entries = [
    ...dump.local.map(({ key, value }) => ({ where: 'localStorage', key, value })),
    ...dump.session.map(({ key, value }) => ({ where: 'sessionStorage', key, value })),
    ...dump.indexed.flatMap(({ database, store, values }) => values.map((value) => ({ where: `indexedDB:${database}/${store}`, key: '', value }))),
  ];
  return entries.flatMap(({ where, key, value }) => [
    ...secrets.filter((secret) => `${key}${value}`.includes(secret)).map(() => ({ where, key, kind: 'secret value' })),
    ...(SECRET_KEY_PATTERN.test(key) ? [{ where, key, kind: 'secret-like key name' }] : []),
  ]);
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

const countOccurrences = (haystack, needle) => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count += 1;
  return count;
};

/** Hits per needle across every file under `directories`. */
async function scanFiles(directories, needles) {
  const files = (await Promise.all(directories.map(filesUnder))).flat();
  const hits = Object.fromEntries(Object.keys(needles).map((name) => [name, 0]));
  for (const file of files) {
    const bytes = await readFile(file);
    for (const [name, needle] of Object.entries(needles)) hits[name] += countOccurrences(bytes, needle);
  }
  return { files: files.length, hits };
}

// ---------- scenario ----------

async function setup(browser, baseUrl, report) {
  const a = await participant(browser, 'en', report, 'A');
  const b = await participant(browser, 'th', report, 'B');
  report.pages.push(a, b);
  return { a, b };
}

const stamp = Date.now();
const TEXT = Object.freeze({
  a: `locked-A-${stamp}`, b: `การ์ดลับ-B-${stamp}`, undo: `locked-undo-${stamp}`,
  concurrentA: `-alpha${stamp}`, concurrentB: `beta${stamp}-`, pending: `pending-B-${stamp}`,
  rotating: `rotating-B-${stamp}`, control: `plain-control-${stamp}`,
});

async function openAndShareSteps({ a, b, report, baseUrl, state }) {
  await step(report, '1. A signs in, creates a locked board and unlocks it on the board screen', async () => {
    await openLanding(a, baseUrl);
    await visitStub(a, baseUrl, FAKE_GOOGLE_DECISION.APPROVE);
    state.board1 = await createLockedBoard(a, baseUrl, PASSWORDS.board1);
    await shot(a, 'password-screen-en.png', report);
    await unlockScreen(a, 'en', PASSWORDS.board1, NAME_A);
    return { board: 'created' };
  });
  await step(report, '2. B: a wrong password shows an error, the right one opens the board', async () => {
    await b.goto(state.board1);
    await passwordScreen(b, 'th').waitFor({ timeout: UNLOCK_TIMEOUT_MS });
    await shot(b, 'password-screen-th.png', report);
    await submitPassword(b, 'th', `${PASSWORDS.board1}x`, LABELS.th.unlock);
    await b.getByRole('alert').filter({ hasText: LABELS.th.wrong }).waitFor({ timeout: UNLOCK_TIMEOUT_MS });
    await shot(b, 'password-wrong-th.png', report);
    await submitPassword(b, 'th', PASSWORDS.board1, LABELS.th.unlock);
    await passwordScreen(b, 'th').waitFor({ state: 'hidden', timeout: UNLOCK_TIMEOUT_MS });
    await enter(b, 'th', NAME_B);
  });
  await step(report, '3. edits sync both ways, concurrent typing converges, undo/redo on A syncs', async () => {
    await addSharedSticky(a, 'en', TEXT.a, STICKY_A_PX);
    await waitForTextOn([a, b], TEXT.a);
    await addSharedSticky(b, 'th', TEXT.b, STICKY_B_PX);
    await waitForTextOn([a, b], TEXT.b);
    // A appends while B prefixes the same card: each run must survive whole and both pages must agree.
    await Promise.all([editCardAt(a, TEXT.a, CARET.END), editCardAt(b, TEXT.a, CARET.START)]);
    await Promise.all([a.keyboard.type(TEXT.concurrentA), b.keyboard.type(TEXT.concurrentB)]);
    await Promise.all([a.keyboard.press('Escape'), b.keyboard.press('Escape')]);
    const converged = (item) => itemText(item) === `${TEXT.concurrentB}${TEXT.a}${TEXT.concurrentA}`;
    const [onA, onB] = await Promise.all([a, b].map((page) => eventually(() => findItem(page, converged), 'concurrent edits did not converge')));
    assert.equal(itemText(onA), itemText(onB), 'both pages hold the same merged text');
    await addSharedSticky(a, 'en', TEXT.undo, STICKY_UNDO_PX);
    await waitForTextOn([a, b], TEXT.undo);
    const presses = await undoUntilHidden(a, TEXT.undo);
    await waitForTextOn([a, b], TEXT.undo, 'hidden');
    for (let count = 0; count < presses; count += 1) await a.keyboard.press(REDO_KEY);
    await waitForTextOn([a, b], TEXT.undo);
    await shot(a, 'board-en.png', report);
    await shot(b, 'board-th.png', report);
    return { mergedText: itemText(onA), undoPresses: presses };
  });
}

async function imageSteps({ a, b, report, baseUrl, state }) {
  await step(report, '4. A adds an image, B sees it decrypted; a drawing saves', async () => {
    const fixture = noisePng();
    const chooser = a.waitForEvent('filechooser');
    await a.locator('[data-tool="image"]').click();
    await (await chooser).setFiles({ name: `noise-${stamp}.png`, mimeType: 'image/png', buffer: fixture });
    await eventually(async () => e2eImageItems(await boardItems(b)).length >= 1, 'B never received the encrypted image item');
    const [source] = await waitForRenderedImages(b, 1);
    const decrypted = await blobBytes(b, source);
    assert.ok(decrypted.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), 'B decrypts a PNG');
    state.imageWindow = middleWindow(decrypted);
    state.fixtureWindow = middleWindow(fixture);
    await a.locator('[data-tool="draw"]').click();
    await a.mouse.move(DRAW_STROKE.from.x, DRAW_STROKE.from.y);
    await a.mouse.down();
    await a.mouse.move(DRAW_STROKE.to.x, DRAW_STROKE.to.y, { steps: DRAW_STROKE.steps });
    await a.mouse.up();
    await a.locator('[data-tool="draw"]').click();
    await eventually(async () => e2eImageItems(await boardItems(b)).length >= 2, 'the drawing never saved as an encrypted image');
    await waitForRenderedImages(b, 2);
    await shot(b, 'images-th.png', report);
    return { decryptedBytes: decrypted.length, imageItems: e2eImageItems(await boardItems(a)).length };
  });
  await step(report, '5. ZIP export, then import into a second locked board shows the images', async () => {
    state.zip = await download(a, 'en', LABELS.en.exportZip, report);
    state.board2 = await createLockedBoard(a, baseUrl, PASSWORDS.board2);
    await unlockScreen(a, 'en', PASSWORDS.board2, NAME_A);
    const chooser = a.waitForEvent('filechooser');
    await openMenu(a, 'en', LABELS.en.import);
    await (await chooser).setFiles(state.zip);
    await a.getByRole('button', { name: LABELS.en.importOk, exact: true }).click();
    await waitForTextOn([a], TEXT.b);
    await waitForRenderedImages(a, 2);
    const items2 = e2eImageItems(await boardItems(a));
    const handleOf = (item) => item.src.split('/')[2];
    assert.ok(items2.length >= 2 && items2.every((item) => handleOf(item) === handleOf(items2[0])), 'imported images share one room');
    const viewer = await b.context().newPage();
    try {
      await viewer.goto(state.board2);
      await unlockScreen(viewer, 'th', PASSWORDS.board2, NAME_B);
      await waitForRenderedImages(viewer, 2);
      await shot(viewer, 'imported-board-th.png', report);
    } finally {
      await viewer.close();
    }
    await a.goto(state.board1);
    await unlockScreen(a, 'en', PASSWORDS.board1, NAME_A);
    return { importedImages: items2.length };
  });
}

async function credentialSteps({ a, b, report, state }) {
  await step(report, '6. B reloads, is asked again; browser storage holds no password or authKey', async () => {
    await b.reload();
    await unlockScreen(b, 'th', PASSWORDS.board1, NAME_B);
    await waitForTextOn([b], TEXT.b);
    const authKey = await deriveAuthKey(b, state.board1, PASSWORDS.board1);
    const secrets = [...Object.values(PASSWORDS), authKey];
    const [dumpA, dumpB] = await Promise.all([dumpBrowserStorage(a), dumpBrowserStorage(b)]);
    const hits = [...secretHits(dumpA, secrets), ...secretHits(dumpB, secrets)];
    assert.deepEqual(hits, [], 'no password, authKey or secret-like key in browser storage');
    const summary = (dump) => ({ localKeys: dump.local.map((entry) => entry.key), sessionKeys: dump.session.map((entry) => entry.key),
      indexed: dump.indexed.map(({ database, store, values }) => ({ database, store, values: values.length })) });
    return { a: summary(dumpA), b: summary(dumpB) };
  });
  await step(report, '7. A changes the password; B re-unlocks at its next renewal and its pending edit survives', async () => {
    await openOwnerMenu(a, 'en');
    await shot(a, 'owner-menu-en.png', report);
    await a.keyboard.press('Escape');
    await submitOwnerDialog(a, {
      menuLabel: LABELS.en.changePassword, current: PASSWORDS.board1, next: PASSWORDS.changed,
      submitLabel: LABELS.en.changeSubmit, timeout: UNLOCK_TIMEOUT_MS,
    });
    await a.getByText(LABELS.en.changed, { exact: true }).waitFor();
    await addSharedSticky(b, 'th', TEXT.pending, STICKY_PENDING_PX);
    const started = Date.now();
    await reunlockDialog(b, 'th').waitFor({ timeout: RENEWAL_REUNLOCK_TIMEOUT_MS });
    const waitedMs = Date.now() - started;
    // A password change keeps the board key, so B's edit may already have reached A before renewal.
    const seenByABeforeReunlock = Boolean(await findItem(a, (item) => itemText(item) === TEXT.pending));
    await shot(b, 'reunlock-th.png', report);
    await reunlock(b, 'th', PASSWORDS.changed);
    await waitForTextOn([a, b], TEXT.pending);
    return { reunlockAfterMs: waitedMs, seenByABeforeReunlock };
  });
  await step(report, '8. while B types, A removes everyone; B re-unlocks and its text is still there', async () => {
    await addSharedSticky(b, 'th', TEXT.rotating, STICKY_ROTATE_PX);
    await waitForTextOn([a, b], TEXT.rotating);
    await editCardAt(b, TEXT.rotating);
    await b.keyboard.type('-typed');
    const rotated = submitOwnerDialog(a, {
      menuLabel: LABELS.en.removeEveryone, current: PASSWORDS.changed, next: PASSWORDS.rotated,
      submitLabel: LABELS.en.rotateSubmit, timeout: ROTATE_TIMEOUT_MS,
    });
    await b.keyboard.type('-more');
    await rotated;
    await Promise.all([
      reunlockDialog(a, 'en').waitFor({ timeout: ROTATE_TIMEOUT_MS }),
      reunlockDialog(b, 'th').waitFor({ timeout: ROTATE_TIMEOUT_MS }),
    ]);
    await shot(a, 'reunlock-en.png', report);
    await reunlock(b, 'th', PASSWORDS.rotated);
    await reunlock(a, 'en', PASSWORDS.rotated);
    await b.keyboard.press('Escape');
    const typed = `${TEXT.rotating}-typed-more`;
    const [onA, onB] = await Promise.all([a, b].map((page) => eventually(
      () => findItem(page, (item) => itemText(item) === typed), `B's typed text is missing after rotation`,
    )));
    assert.equal(itemText(onA), itemText(onB));
    await waitForRenderedImages(b, 2);
    return { text: itemText(onB) };
  });
}

async function finalSteps({ a, report, baseUrl, state }) {
  await step(report, '9. relay DB and uploads hold no plaintext card text or image bytes', async () => {
    await a.evaluate(() => localStorage.setItem('rb_lang', 'th'));
    await a.reload();
    await unlockScreen(a, 'th', PASSWORDS.rotated, NAME_A);
    await openOwnerMenu(a, 'th');
    await shot(a, 'owner-menu-th.png', report);
    await a.keyboard.press('Escape');
    await a.evaluate(() => localStorage.setItem('rb_lang', 'en'));
    await openLanding(a, baseUrl);
    await a.getByRole('button', { name: BASE_LABELS.en.create, exact: true }).click();
    await a.waitForURL(BOARD_URL_PATTERN);
    await enter(a, 'en', NAME_A);
    await addSharedSticky(a, 'en', TEXT.control, STICKY_CONTROL_PX);
    await a.waitForTimeout(PERSIST_SETTLE_MS);
    const utf8 = (text) => Buffer.from(text, 'utf8');
    const secretNeedles = {
      textA: utf8(TEXT.a), textB: utf8(TEXT.b), undo: utf8(TEXT.undo), concurrentA: utf8(TEXT.concurrentA),
      concurrentB: utf8(TEXT.concurrentB), pending: utf8(TEXT.pending), rotating: utf8(TEXT.rotating),
      imageWindow: state.imageWindow, fixtureWindow: state.fixtureWindow,
    };
    const controls = { plainControlText: utf8(TEXT.control), e2eHeadKey: utf8('e2e-head') };
    const { files, hits } = await scanFiles([join(report.out, 'db'), join(report.out, 'uploads')], { ...secretNeedles, ...controls });
    for (const name of Object.keys(controls)) assert.ok(hits[name] > 0, `positive control ${name} must be found`);
    const leaks = Object.keys(secretNeedles).filter((name) => hits[name] > 0);
    assert.deepEqual(leaks, [], 'plaintext found on disk');
    return { files, hits };
  });
}

// The whole run must end: a stuck step exits non-zero instead of hanging the caller.
const OVERALL_DEADLINE_MS = 15 * 60_000;
const DEADLINE_EXIT_CODE = 124;
setTimeout(() => {
  console.error(`FAIL: room-lock live check exceeded ${OVERALL_DEADLINE_MS} ms`);
  process.exit(DEADLINE_EXIT_CODE);
}, OVERALL_DEADLINE_MS).unref();

await runLiveCheck('room-lock-live-check.mjs', async (context) => {
  const state = {};
  await openAndShareSteps({ ...context, state });
  await imageSteps({ ...context, state });
  await credentialSteps({ ...context, state });
  await finalSteps({ ...context, state });
}, { setup });
