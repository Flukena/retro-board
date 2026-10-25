#!/usr/bin/env node
// Local-only shared Public management regression: no production URLs or confirmed Clear/Reset.
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js/index-native.js';
import { createJsonBackupArtifact } from '../src/client/transfer/board-backup.js';
import { t, setLang } from '../src/client/ui/i18n.js';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const PLAYWRIGHT_MODULE = '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 150;
const PAN_STEPS = 8;
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const RESULTS_VIEWPORT_WIDTHS_PX = [360, 390];
const TOUCH_TARGET_MIN_PX = 44;
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const [baseArg, outputArg, engine = 'chromium'] = process.argv.slice(2);
assert.ok(baseArg && outputArg, 'Pass isolated local base URL and external output directory');
const base = new URL(baseArg);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5187', 'Use the dedicated management server on local port 5187');
const output = resolve(outputArg);
assert.ok(output.startsWith(`${SSD_ROOT}/`), 'Artifacts must use operator SSD');
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev, 'SSD must be mounted');
await mkdir(join(output, 'browser-temp'), { recursive: true });
process.env.TMPDIR = join(output, 'browser-temp');
const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || PLAYWRIGHT_MODULE).href);
assert.ok(['chromium', 'webkit'].includes(engine));
const browser = await playwright[engine].launch({ headless: true });
const report = { engine, steps: [], errors: [], fixtureIds: [] };
const prefix = `management-${Date.now()}`;
const ids = { zone: `${prefix}-zone`, note: `${prefix}-note`, imported: `${prefix}-imported` };
const contexts = [];
let mobile;
let desktop;

function word(user, key) { setLang(user.lang); return t(key); }
async function state(user) { return user.page.evaluate(async () => (await window.storage.get('boardState', true)).value); }
async function wait(check, message) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, POLL_INTERVAL_MS));
  }
  assert.fail(message);
}
async function activate(user, target) {
  await target.scrollIntoViewIfNeeded();
  if (user.mobile) await target.tap();
  else await target.click();
}
async function noPin(user) { assert.equal(await user.page.getByPlaceholder('••••', { exact: true }).count(), 0, 'Public shared tools must never request a private admin PIN'); }
async function step(name, action) {
  await action();
  await noPin(mobile);
  await noPin(desktop);
  report.steps.push(name);
  console.log(`PASS ${name}`);
}
async function participant(isMobile, lang) {
  const context = await browser.newContext({ viewport: isMobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT, isMobile, hasTouch: isMobile, acceptDownloads: true });
  contexts.push(context);
  await context.addInitScript(value => localStorage.setItem('rb_lang', value), lang);
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.on('pageerror', error => report.errors.push(error.message));
  const user = { page, mobile: isMobile, lang };
  await page.goto(new URL('/public', base).href, { waitUntil: 'domcontentloaded' });
  const name = page.getByPlaceholder(word(user, 'name.placeholder'), { exact: true });
  await name.fill(`Management ${lang}`);
  await activate(user, page.getByRole('button', { name: word(user, 'name.confirm'), exact: true }));
  await page.locator('.rb-no-select').waitFor();
  const close = page.locator('.rb-template-popover').getByRole('button', { name: word(user, 'common.close'), exact: true });
  if (await close.isVisible()) await activate(user, close);
  else if (await page.locator('.rb-template-backdrop').isVisible()) await page.locator('.rb-template-backdrop').click({ position: { x: 1, y: 1 } });
  return user;
}
function zone(user) { return user.page.locator('.rb-zone').filter({ has: user.page.locator('.rb-zone__label', { hasText: ids.zone }) }); }
function note(user) { return user.page.locator('.rb-sticky').filter({ hasText: ids.note }); }
async function fit(user) { await activate(user, user.page.getByTitle(word(user, 'zoom.fit'), { exact: true })); }
async function frame(user, target) {
  await fit(user);
  const box = await target.boundingBox();
  assert.ok(box, 'Fixture control must be rendered');
  const canvas = await user.page.locator('.rb-no-select').boundingBox();
  const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  await user.page.mouse.move(center.x, center.y);
  await user.page.mouse.down({ button: 'middle' });
  await user.page.mouse.move(center.x + center.x - box.x - box.width / 2, center.y + center.y - box.y - box.height / 2, { steps: PAN_STEPS });
  await user.page.mouse.up({ button: 'middle' });
  await activate(user, user.page.locator('.rb-zoom-percentage'));
}
async function fixture() {
  const original = await state(mobile);
  assert.equal(original.items.length, 0, 'The management relay must start empty and fully isolated');
  report.fixtureIds.push(ids.zone, ids.note, ids.imported);
  await mobile.page.evaluate(({ zoneId, noteId }) => {
    assertFixture(window.storage.addItems([
      { id: zoneId, type: 'zone', x: 0, y: 0, w: 1200, h: 1080, color: 2, title: zoneId, createdAt: Date.now() },
      { id: noteId, type: 'sticky', x: 120, y: 140, w: 220, h: 180, color: 0, text: noteId, private: false, parentZoneId: zoneId, createdAt: Date.now() + 1 },
    ]));
    function assertFixture(result) { if (!result) throw new Error('Fixture write rejected'); }
  }, { zoneId: ids.zone, noteId: ids.note });
  await wait(async () => (await state(desktop)).items.some(item => item.id === ids.note), 'Fixture must sync to the English peer');
}
async function voteFlow() {
  const start = zone(mobile).getByRole('button', { name: word(mobile, 'zone.startVote'), exact: true }).filter({ visible: true });
  await frame(mobile, start);
  await activate(mobile, start);
  const setup = mobile.page.locator('.rb-timer-setup');
  await setup.waitFor();
  await activate(mobile, setup.getByRole('button', { name: word(mobile, 'vote.setup.start'), exact: true }));
  await wait(async () => (await state(desktop)).items.find(item => item.id === ids.zone)?.voteTimer, 'Public timer must sync');
  await frame(desktop, note(desktop));
  await activate(desktop, note(desktop).locator('.rb-sticky__vote-pill'));
  await wait(async () => mobile.page.evaluate(id => (window.storage.snapshotVotes().get(id)?.size || 0) === 1, ids.note), 'English peer vote must sync to mobile');
  const stop = mobile.page.locator('.rb-timer-dock').getByRole('button', { name: word(mobile, 'topbar.stopVote'), exact: true });
  await activate(mobile, stop);
  await wait(async () => {
    const item = (await state(desktop)).items.find(value => value.id === ids.zone);
    return !item.voteTimer && !!item.voteResults;
  }, 'Stopping Public voting must finalize actual results');
}
async function resultsBounds() {
  const panel = mobile.page.locator('.rb-results');
  await panel.waitFor();
  await panel.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
  for (const width of RESULTS_VIEWPORT_WIDTHS_PX) {
    await mobile.page.setViewportSize({ ...MOBILE_VIEWPORT, width });
    const bounds = await panel.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `Results must fit ${width}px viewport`);
    const close = panel.locator('.rb-results__close');
    const target = await close.boundingBox();
    assert.ok(target && target.width >= TOUCH_TARGET_MIN_PX && target.height >= TOUCH_TARGET_MIN_PX, 'Results close must retain a 44px touch target');
    assert.ok(target.x >= 0 && target.x + target.width <= width, 'Results close must remain onscreen');
    assert.ok(await close.evaluate(element => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), 'Results close center must receive actual pointer hits');
    await mobile.page.screenshot({ path: join(output, `results-${width}.png`) });
  }
  await activate(mobile, panel.locator('.rb-results__close'));
  await panel.waitFor({ state: 'hidden' });
}
async function editPublicNote(user, text) {
  await frame(user, note(user));
  await note(user).dblclick();
  const editor = user.mobile ? user.page.locator('.rb-mobile-editor__input') : note(user).locator('textarea');
  await editor.fill(text);
  if (user.mobile) await activate(user, user.page.getByRole('button', { name: word(user, 'mobile.done'), exact: true }));
  else await editor.press('Escape');
}
async function expectNote(user, text) {
  await wait(async () => (await state(user)).items.find(item => item.id === ids.note)?.text === text, 'Public note text must sync');
}
async function publicEditing() {
  await mobile.page.evaluate(() => window.storage.setMeta({ editingLocked: true }));
  await wait(async () => (await state(desktop)).editingLocked === true, 'Legacy lock fixture must reach the peer');
  for (const user of [mobile, desktop]) {
    await user.page.reload();
    await user.page.locator('.rb-no-select').waitFor();
    for (const key of ['topbar.lockEdit', 'topbar.unlockEdit', 'topbar.editingLocked']) {
      assert.equal(await user.page.getByRole('button', { name: word(user, key), exact: true }).count(), 0, 'Public has no board-wide editing lock');
    }
  }
  for (const user of [mobile, desktop]) {
    const before = (await state(user)).items.find(item => item.id === ids.note).text;
    const text = `${ids.note} ${user.lang}`;
    const peer = user === mobile ? desktop : mobile;
    await editPublicNote(user, text);
    await expectNote(peer, text);
    await activate(user, user.page.getByTitle(word(user, 'topbar.undo'), { exact: true }));
    await expectNote(peer, before);
    await activate(user, user.page.getByTitle(word(user, 'topbar.redo'), { exact: true }));
    await expectNote(peer, text);
    assert.equal((await state(peer)).editingLocked, true, 'Public edits and history must ignore, not overwrite, the legacy flag');
  }
}
async function zoneControls() {
  const options = zone(desktop).getByRole('button', { name: word(desktop, 'zone.options'), exact: true });
  await activate(desktop, desktop.page.locator('.rb-results__close'));
  await fit(desktop);
  await activate(desktop, options);
  const lock = zone(desktop).getByRole('button', { name: word(desktop, 'zone.lockToggle.on'), exact: true }).filter({ visible: true });
  await activate(desktop, lock);
  await wait(async () => (await state(mobile)).items.find(item => item.id === ids.zone)?.locked === true, 'Zone lock must sync');
  const unlock = zone(desktop).getByRole('button', { name: word(desktop, 'zone.lockToggle.off'), exact: true }).filter({ visible: true });
  if (!(await unlock.isVisible())) await activate(desktop, options);
  await activate(desktop, unlock);
  const reveal = zone(desktop).getByRole('button', { name: word(desktop, 'zone.revealCards'), exact: true }).filter({ visible: true });
  await activate(desktop, reveal);
  await wait(async () => (await state(mobile)).items.find(item => item.id === ids.zone)?.revealed === true, 'Zone reveal must sync');
}
async function more(user, key) {
  await activate(user, user.page.getByTitle(word(user, 'topbar.more'), { exact: true }));
  const menu = user.page.locator('.rb-topbar-popover--more');
  await menu.waitFor();
  await activate(user, menu.getByRole('button', { name: word(user, key), exact: true }));
}
async function cancelDialog(key, heading) {
  const before = JSON.stringify(await state(mobile));
  await more(mobile, key);
  const dialog = mobile.page.getByRole('dialog').filter({ has: mobile.page.getByText(word(mobile, heading), { exact: true }) });
  await dialog.waitFor();
  await activate(mobile, dialog.getByRole('button', { name: word(mobile, 'common.cancel'), exact: true }));
  assert.equal(JSON.stringify(await state(mobile)), before, 'Cancelling destructive management must preserve shared state');
}
async function uploadImage() {
  const before = new Set((await state(mobile)).items.map(item => item.id));
  const chooserReady = mobile.page.waitForEvent('filechooser');
  await activate(mobile, mobile.page.locator('[data-tool="image"]'));
  const chooser = await chooserReady;
  await chooser.setFiles({ name: `${prefix}.png`, mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64') });
  await wait(async () => {
    const item = (await state(mobile)).items.find(value => value.type === 'image' && !before.has(value.id));
    if (item && !report.fixtureIds.includes(item.id)) report.fixtureIds.push(item.id);
    return !!item;
  }, 'Own Public PNG upload must become a board item');
}
async function importJson() {
  const board = await state(mobile);
  const extra = { id: ids.imported, type: 'text', x: 400, y: 200, text: ids.imported, createdAt: Date.now() };
  const artifact = createJsonBackupArtifact({ board: { ...board, items: [...board.items, extra] }, pathname: '/public' });
  const chooserReady = desktop.page.waitForEvent('filechooser');
  await more(desktop, 'topbar.import');
  const chooser = await chooserReady;
  await chooser.setFiles({ name: `${prefix}.json`, mimeType: 'application/json', buffer: Buffer.from(artifact.contents) });
  const dialog = desktop.page.getByRole('dialog').filter({ has: desktop.page.getByText(word(desktop, 'import.confirm.head'), { exact: true }) });
  await dialog.waitFor();
  await activate(desktop, dialog.getByRole('button', { name: word(desktop, 'import.confirm.ok'), exact: true }));
  await wait(async () => (await state(mobile)).items.some(item => item.id === ids.imported), 'Confirmed valid Public JSON import must sync');
  const importedIds = new Set((await state(mobile)).items.map(item => item.id));
  for (const item of board.items) assert.ok(importedIds.has(item.id), 'Import fixture must preserve every existing item');
}
async function exportZip() {
  const downloadReady = desktop.page.waitForEvent('download');
  await more(desktop, 'topbar.export');
  const download = await downloadReady;
  const path = join(output, 'public-management.zip');
  await download.saveAs(path);
  const bytes = await readFile(path);
  const reader = new ZipReader(new BlobReader(new Blob([bytes])));
  try {
    const entries = await reader.getEntries();
    const manifest = JSON.parse(await entries.find(entry => entry.filename === 'board.json').getData(new TextWriter()));
    assert.ok(manifest.board.items.some(item => item.id === ids.imported));
    assert.ok(entries.some(entry => entry.filename.endsWith('.png')), 'Actual ZIP export must include the uploaded PNG bytes');
  } finally { await reader.close(); }
}
async function cleanup() {
  if (!mobile) return;
  await mobile.page.evaluate(fixtureIds => {
    for (const id of fixtureIds) window.storage.removeItem(id);
    window.storage.setMeta({ editingLocked: false });
  }, report.fixtureIds);
}
try {
  mobile = await participant(true, 'th');
  desktop = await participant(false, 'en');
  await step('isolated two-context fixture sync', fixture);
  await step('mobile Public timer setup, desktop vote and actual result finalization', voteFlow);
  await step('results fit360/390px and close through a reachable touch target', resultsBounds);
  await step('English peer zone lock/unlock and reveal sync', zoneControls);
  await step('Public has no editing lock and both peers edit/undo/redo despite a legacy locked flag', publicEditing);
  await step('Clear confirmation CANCEL preserves actual state', () => cancelDialog('topbar.clear', 'clear.confirm.head'));
  await step('Reset confirmation CANCEL preserves actual state', () => cancelDialog('topbar.resetVotes', 'reset.confirm.head'));
  await step('own PNG upload through the visible public Image tool', uploadImage);
  await step('valid JSON import preserves all fixtures and synchronizes', importJson);
  await step('actual ZIP export contains imported data and own PNG', exportZip);
  assert.deepEqual(report.errors, []);
  await mobile.page.screenshot({ path: join(output, 'management-mobile.png') });
  await desktop.page.screenshot({ path: join(output, 'management-desktop.png') });
} catch (error) {
  report.failure = error.stack;
  if (mobile) await mobile.page.screenshot({ path: join(output, 'failure-mobile.png') });
  throw error;
} finally {
  await cleanup();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const context of contexts) await context.close();
  await browser.close();
}
