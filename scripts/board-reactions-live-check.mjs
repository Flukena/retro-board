#!/usr/bin/env node
/**
 * Two-context live check of board emoji reactions (English A, Thai B) using global Playwright.
 * Plain board: start isolated servers as in ui-live-check.mjs's header (free ports, db/uploads under the output), then
 *   node scripts/board-reactions-live-check.mjs http://localhost:<vite> <BaseData output>
 * Locked (end-to-end encrypted) board: start the fake Google and a sign-in relay as in room-lock-live-check.mjs's
 * header, then pass `locked` as the third argument; A signs in, creates a password-protected board, B unlocks it.
 * Run it under a hard timeout. Creates one board; screenshots (taken mid-animation) and report.json stay in the output.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { REACTION_SEND_INTERVAL_MS } from '../src/client/reactions/reaction-rate-limiter.js';
import { FIREWORKS_DURATION_MS, FLOAT_DURATION_MS } from '../src/client/reactions/reaction-timeline.js';
import {
  CANVAS_SELECTOR, FAKE_GOOGLE_DECISION, REDO_KEY, SYNC_TIMEOUT_MS, UNDO_KEY, VIEWPORT, addSharedSticky,
  createLockedBoard, openLanding, participant, runLiveCheck, step, undoUntilHidden, unlockScreen, visitStub,
  waitForTextOn,
} from './board-live-helpers.mjs';

const MODE = Object.freeze({ PLAIN: 'plain', LOCKED: 'locked' });
const mode = process.argv[4] ?? MODE.PLAIN;
if (!Object.values(MODE).includes(mode)) throw new Error(`mode must be ${Object.values(MODE).join(' or ')}`);

const NAME_A = 'Ada';
const NAME_B = 'บี';
const LABELS = Object.freeze({
  en: { open: 'Send a reaction to everyone', picker: 'Reactions', fireworks: 'Fireworks for everyone', send: 'Send' },
  th: { open: 'ส่งอีโมจิให้ทุกคนในบอร์ด', picker: 'เลือกอีโมจิ', fireworks: 'จุดพลุให้ทุกคน', send: 'ส่ง' },
});
const FIREWORKS = '🎆';
const FIREWORKS_SELECTOR = 'canvas[data-reaction-look="fireworks"]';
const FLOAT_SELECTOR = '[data-reaction-look="float"]';
const STILL_SELECTOR = '[data-reaction-look="still"]';
const DOCK_SELECTOR = '.rb-reaction-dock';
// The effect has ended once its element is gone; allow the expiry timer and a slow CI frame on top.
const EFFECT_END_SLACK_MS = 1500;
const COOLDOWN_SLACK_MS = 200;
const SPAM_CLICKS = 12;
const SPAM_GAP_MS = 100;
const STILL_SAMPLE_GAP_MS = 300;
const SETTLE_MS = 400;
// Screenshots wait until the bursts have spread out a little; the first frame is a dot per burst.
const MID_SHOW_DELAY_MS = 350;
const FIRST_PAINT_TIMEOUT_MS = 1000;
const STICKY_PX = Object.freeze({ x: 520, y: 380 });
const EMPTY_CANVAS_PX = Object.freeze({ x: 760, y: 640 });
const ALPHA_CHANNEL_OFFSET = 3;
const RGBA_STRIDE = 4;
const LAYOUT_VIEWPORTS = Object.freeze([
  { name: 'desktop-short', width: 1280, height: 600 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-360', width: 360, height: 740 },
  { name: 'phone-landscape', width: 740, height: 360 },
]);
const CHROME_SELECTORS = Object.freeze(['.rb-zoom-controls', '.rb-minimap', '.rb-tool-dock__body', '.rb-selection-toolbar']);
const stamp = Date.now();
const STICKY_TEXT = `reaction-undo-${stamp}`;
const password = `reactions-${randomBytes(9).toString('base64url')}`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const waitForCooldown = () => sleep(REACTION_SEND_INTERVAL_MS + COOLDOWN_SLACK_MS);
const reactionLabel = (lang, emoji) => (emoji === FIREWORKS ? LABELS[lang].fireworks : `${LABELS[lang].send} ${emoji}`);

/** Screenshot without waiting for animations to finish: these effects only exist mid-animation. */
async function snap(page, name, report) {
  const path = join(report.out, name);
  await page.screenshot({ path });
  report.screenshots.push(path);
  return path;
}

async function openPicker(page, lang) {
  const toggle = page.getByRole('button', { name: LABELS[lang].open, exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const picker = page.getByRole('group', { name: LABELS[lang].picker, exact: true });
  await picker.waitFor();
  // The popover pops in (scale + fade); measure and capture it at rest, not part-way through.
  await picker.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)));
}

async function react(page, lang, emoji) {
  await openPicker(page, lang);
  await page.getByRole('button', { name: reactionLabel(lang, emoji), exact: true }).click();
}

/** Records every reaction the page's channel delivers (one subscription per page; each call empties the log). */
const recordDeliveries = (page) => page.evaluate(() => {
  if (!window.__rbReactionLog) {
    window.__rbReactionLog = [];
    window.storage.boardReactions.subscribe((event) => window.__rbReactionLog.push({ ...event, at: Date.now() }));
  }
  window.__rbReactionLog.length = 0;
});
const deliveries = (page) => page.evaluate(() => window.__rbReactionLog);

/** Waits for the fireworks canvas to hold painted pixels (a blank canvas fails) and returns how many. */
async function waitForPaint(page) {
  const handle = await page.waitForFunction(([selector, alphaOffset, stride]) => {
    const canvas = document.querySelector(selector);
    if (!canvas) return 0;
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let index = alphaOffset; index < data.length; index += stride) if (data[index] > 0) painted += 1;
    return painted;
  }, [FIREWORKS_SELECTOR, ALPHA_CHANNEL_OFFSET, RGBA_STRIDE], { timeout: FIRST_PAINT_TIMEOUT_MS });
  return handle.jsonValue();
}

/** Waits for the effect to go and returns how long it was on screen since `shownAt`. */
async function waitForEffectEnd(page, selector, durationMs, shownAt) {
  await page.locator(selector).first().waitFor({ state: 'detached', timeout: durationMs + EFFECT_END_SLACK_MS });
  return Date.now() - shownAt;
}

const intersects = (one, other) => one.x < other.x + other.width && other.x < one.x + one.width
  && one.y < other.y + other.height && other.y < one.y + one.height;

async function visibleBox(page, selector) {
  const locator = page.locator(selector).first();
  if (!await locator.count() || !await locator.isVisible()) return null;
  return locator.boundingBox();
}

/** True when every emoji button of the open picker is the topmost element at its centre. */
const pickerOnTop = (page) => page.evaluate(() => [...document.querySelectorAll('.rb-reaction-picker__emoji')].every((button) => {
  const box = button.getBoundingClientRect();
  return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
}));

/** The pill and its open picker stay inside the viewport and clear of every bottom/rail chrome box. */
async function checkPlacement(page, viewport) {
  const dock = await visibleBox(page, DOCK_SELECTOR);
  if (!dock) throw new Error(`${viewport.name}: reaction pill not visible`);
  const picker = await visibleBox(page, '.rb-reaction-picker');
  const inside = (box) => box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  if (!inside(dock) || (picker && !inside(picker))) throw new Error(`${viewport.name}: pill or picker leaves the viewport`);
  const overlaps = [];
  for (const selector of CHROME_SELECTORS) {
    const box = await visibleBox(page, selector);
    if (box && intersects(dock, box)) overlaps.push(selector);
  }
  if (overlaps.length) throw new Error(`${viewport.name}: pill overlaps ${overlaps.join(', ')}`);
  if (picker && !await pickerOnTop(page)) throw new Error(`${viewport.name}: another element covers the open picker`);
  return { dock, picker };
}

async function lockedSetup(browser, baseUrl, report) {
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

async function fireworksStep({ a, b, report }) {
  await step(report, `${mode}: A sends 🎆 and B sees full-screen fireworks that end by about 2 s`, async () => {
    await recordDeliveries(a);
    await recordDeliveries(b);
    await react(a, 'en', FIREWORKS);
    await b.locator(FIREWORKS_SELECTOR).waitFor({ state: 'attached', timeout: SYNC_TIMEOUT_MS });
    const shownAt = Date.now();
    const firstPaintOnB = await waitForPaint(b);
    await sleep(MID_SHOW_DELAY_MS);
    await snap(b, `${mode}-fireworks-th.png`, report);
    await snap(a, `${mode}-fireworks-en.png`, report);
    const visibleForMs = await waitForEffectEnd(b, FIREWORKS_SELECTOR, FIREWORKS_DURATION_MS, shownAt);
    const [atA, atB] = [await deliveries(a), await deliveries(b)];
    if (atA.length !== 1 || atB.length !== 1) throw new Error(`plays: A ${atA.length}, B ${atB.length} (want 1 each)`);
    if (atB[0].name !== NAME_A) throw new Error(`B saw sender ${atB[0].name}`);
    return { firstPaintOnB, visibleForMs, deliveredToB: atB.length };
  });
}

async function floatStep({ a, b, report }) {
  await step(report, `${mode}: B sends 👏 and A sees it float up with B's name`, async () => {
    await react(b, 'th', '👏');
    const float = a.locator(FLOAT_SELECTOR).filter({ hasText: NAME_B }).filter({ hasText: '👏' });
    await float.waitFor({ timeout: SYNC_TIMEOUT_MS });
    const shownAt = Date.now();
    await sleep(MID_SHOW_DELAY_MS);
    const animation = await float.evaluate((node) => getComputedStyle(node).animationName);
    await snap(a, `${mode}-float-en.png`, report);
    await snap(b, `${mode}-float-th.png`, report);
    if (animation === 'none') throw new Error('the float does not move');
    const visibleForMs = await waitForEffectEnd(a, FLOAT_SELECTOR, FLOAT_DURATION_MS, shownAt);
    return { animation, visibleForMs };
  });
}

async function spamStep({ a, b, report }) {
  await step(report, `${mode}: spam-clicking 👍 sends at most about one per second`, async () => {
    await waitForCooldown();
    await recordDeliveries(b);
    await openPicker(a, 'en');
    const button = a.getByRole('button', { name: reactionLabel('en', '👍'), exact: true });
    const started = Date.now();
    for (let click = 0; click < SPAM_CLICKS; click += 1) {
      // force: the cooldown marks the buttons aria-disabled, which Playwright would otherwise wait out.
      await button.click({ force: true });
      await sleep(SPAM_GAP_MS);
    }
    const spanMs = Date.now() - started;
    await sleep(SETTLE_MS);
    const received = (await deliveries(b)).filter((event) => event.emoji === '👍').length;
    const allowed = Math.floor(spanMs / REACTION_SEND_INTERVAL_MS) + 1;
    if (received < 1 || received > allowed) throw new Error(`B got ${received} 👍 from ${SPAM_CLICKS} clicks over ${spanMs} ms`);
    return { clicks: SPAM_CLICKS, spanMs, received, allowed };
  });
}

async function undoStep({ a, b, report }) {
  await step(report, `${mode}: reactions add nothing to undo; undo/redo of a sticky still syncs`, async () => {
    const canUndo = (page) => page.evaluate(() => window.storage.canUndo());
    if (await canUndo(b)) throw new Error('B can undo before editing anything');
    await waitForCooldown();
    await react(b, 'th', '🔥');
    await sleep(SETTLE_MS);
    if (await canUndo(b)) throw new Error('a reaction entered B’s undo history');
    await b.locator(CANVAS_SELECTOR).click({ position: EMPTY_CANVAS_PX });
    await addSharedSticky(a, 'en', STICKY_TEXT, STICKY_PX);
    await waitForTextOn([a, b], STICKY_TEXT);
    await waitForCooldown();
    await react(a, 'en', '❤️');
    await a.locator(CANVAS_SELECTOR).click({ position: EMPTY_CANVAS_PX });
    const presses = await undoUntilHidden(a, STICKY_TEXT);
    await waitForTextOn([b], STICKY_TEXT, 'hidden');
    for (let press = 0; press < presses; press += 1) await a.keyboard.press(REDO_KEY);
    await waitForTextOn([a, b], STICKY_TEXT);
    return { undoPresses: presses, undoKey: UNDO_KEY, bCanUndoAfterReaction: false };
  });
}

async function reducedMotionStep({ a, b, report }) {
  await step(report, `${mode}: with reduced motion B gets a still, non-flashing badge instead of particles`, async () => {
    await b.emulateMedia({ reducedMotion: 'reduce' });
    await waitForCooldown();
    await react(a, 'en', FIREWORKS);
    const still = b.locator(STILL_SELECTOR).filter({ hasText: NAME_A });
    await still.waitFor({ timeout: SYNC_TIMEOUT_MS });
    const first = await still.boundingBox();
    await snap(b, `${mode}-still-th.png`, report);
    await sleep(STILL_SAMPLE_GAP_MS);
    const second = await still.boundingBox();
    const animation = await still.evaluate((node) => getComputedStyle(node).animationName);
    const canvases = await b.locator(FIREWORKS_SELECTOR).count();
    await b.emulateMedia({ reducedMotion: 'no-preference' });
    if (canvases !== 0 || animation !== 'none') throw new Error(`B drew ${canvases} canvases, animation ${animation}`);
    if (first.x !== second.x || first.y !== second.y) throw new Error('the still badge moved');
    return { animation, canvases, box: first };
  });
}

async function layoutStep({ a, report }) {
  await step(report, `${mode}: the pill stays clear of the rail, zoom bar, minimap and selection toolbar`, async () => {
    const results = {};
    await a.locator(CANVAS_SELECTOR).click({ position: EMPTY_CANVAS_PX });
    await a.keyboard.press('ControlOrMeta+a');
    for (const viewport of LAYOUT_VIEWPORTS) {
      await a.setViewportSize({ width: viewport.width, height: viewport.height });
      await sleep(SETTLE_MS);
      await openPicker(a, 'en');
      results[viewport.name] = await checkPlacement(a, viewport);
      await snap(a, `${mode}-layout-${viewport.name}-en.png`, report);
    }
    await a.setViewportSize(VIEWPORT);
    return results;
  });
}

async function drawingStep({ a, report }) {
  await step(report, `${mode}: on a phone the drawing toolbar takes the bottom row and the pill steps aside`, async () => {
    const phone = LAYOUT_VIEWPORTS.find((viewport) => viewport.name === 'phone-390');
    await a.setViewportSize({ width: phone.width, height: phone.height });
    await a.keyboard.press('Escape');
    await a.locator('[data-tool="draw"]').click();
    await a.locator('.rb-drawing-toolbar').waitFor();
    // The toolbar fades in; wait until it is fully shown so the screenshot proves it owns the bottom row.
    await a.waitForFunction(() => getComputedStyle(document.querySelector('.rb-drawing-toolbar')).opacity === '1');
    const hidden = !await a.locator(DOCK_SELECTOR).isVisible();
    await snap(a, `${mode}-drawing-phone-en.png`, report);
    await a.locator('[data-tool="draw"]').click();
    await a.locator('.rb-drawing-toolbar').waitFor({ state: 'detached' });
    const back = await a.locator(DOCK_SELECTOR).isVisible();
    await a.setViewportSize(VIEWPORT);
    if (!hidden || !back) throw new Error(`pill hidden while drawing: ${hidden}, back after: ${back}`);
    return { hiddenWhileDrawing: hidden, visibleAfter: back };
  });
}

async function errorsStep({ report }) {
  await step(report, `${mode}: no page errors`, async () => {
    if (report.pageErrors.length) throw new Error(JSON.stringify(report.pageErrors));
    return { consoleErrors: report.consoleErrors.length };
  });
}

await runLiveCheck('board-reactions-live-check.mjs', async (context) => {
  await fireworksStep(context);
  await floatStep(context);
  await spamStep(context);
  await undoStep(context);
  await reducedMotionStep(context);
  await layoutStep(context);
  await drawingStep(context);
  await errorsStep(context);
}, mode === MODE.LOCKED ? { setup: lockedSetup } : {});
