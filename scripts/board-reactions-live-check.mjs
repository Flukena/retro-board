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
import { BOARD_REACTIONS, REACTION_SEND_INTERVAL_MS } from '../src/domain/board-reactions.js';
import { FIREWORKS_DURATION_MS, FLOAT_DURATION_MS } from '../src/client/reactions/reaction-timeline.js';
import { FIRST_BURST_BY_MS } from '../src/client/reactions/fireworks-physics.js';
import {
  CANVAS_SELECTOR, LAYOUT_VIEWPORTS, NAME_A, NAME_B, REDO_KEY, SYNC_TIMEOUT_MS, UNDO_KEY, VIEWPORT, addSharedSticky,
  errorsStep, intersects, liveMode, liveSetupFor, runLiveCheck, sleep, step, undoUntilHidden, visibleBox,
  waitForTextOn,
} from './board-live-helpers.mjs';

const mode = liveMode();

const LABELS = Object.freeze({
  en: { open: 'Send a reaction to everyone', picker: 'Reactions', fireworks: 'Fireworks for everyone', send: 'Send' },
  th: { open: 'ส่งรีแอคชันให้ทุกคน', picker: 'เลือกอีโมจิ', fireworks: 'จุดพลุให้ทุกคน', send: 'ส่ง' },
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
// Float screenshots wait until the emoji has risen a little.
const MID_SHOW_DELAY_MS = 350;
// Fireworks screenshots wait for the first burst to spread out; before it there are only rising rockets.
const BURST_SPREAD_MS = 300;
const FIREWORKS_SNAP_DELAY_MS = FIRST_BURST_BY_MS + BURST_SPREAD_MS;
const MS_PER_SECOND = 1000;
const FIRST_PAINT_TIMEOUT_MS = 1000;
// Turning on reduced motion mid-show must stop the fireworks at once, far sooner than their natural end.
const MOTION_STOP_TIMEOUT_MS = 500;
const STICKY_PX = Object.freeze({ x: 520, y: 380 });
const EMPTY_CANVAS_PX = Object.freeze({ x: 760, y: 640 });
// Empty board in every layout viewport: right of the phone rail, under the top bar, left of the sticky.
const LAYOUT_EMPTY_PX = Object.freeze({ x: 200, y: 180 });
const ALPHA_CHANNEL_OFFSET = 3;
const RGBA_STRIDE = 4;
const ZOOM_SELECTOR = '.rb-zoom-controls';
const PICKER_SELECTOR = '.rb-reaction-picker';
const SELECTION_TOOLBAR_SELECTOR = '.rb-selection-toolbar';
const CHROME_SELECTORS = Object.freeze([ZOOM_SELECTOR, '.rb-minimap', '.rb-tool-dock__body', SELECTION_TOOLBAR_SELECTOR]);
// The narrowest phone, where the open picker shows only part of the row and must be scrolled by touch.
const TOUCH_SCROLL_VIEWPORT = LAYOUT_VIEWPORTS.find(({ name }) => name === 'phone-320');
const LAST_REACTION = BOARD_REACTIONS.at(-1);
const stamp = Date.now();
const STICKY_TEXT = `reaction-undo-${stamp}`;
const password = `reactions-${randomBytes(9).toString('base64url')}`;

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


/**
 * The open picker's emoji buttons whose centre is inside its scroll area, as `{ emoji, x, y, onTop }`. On narrow
 * phones the picker scrolls sideways, so buttons scrolled out of it are left out.
 */
const shownPickerButtons = (page) => page.evaluate((selector) => {
  const picker = document.querySelector(selector);
  // The scroll area is the client box: inside the border, where scrolled content is clipped.
  const scrollLeft = picker.getBoundingClientRect().left + picker.clientLeft;
  const scrollRight = scrollLeft + picker.clientWidth;
  return [...picker.querySelectorAll('button')].map((button) => {
    const box = button.getBoundingClientRect();
    return { button, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }).filter(({ x }) => x > scrollLeft && x < scrollRight).map(({ button, x, y }) => ({
    emoji: button.textContent, x, y, onTop: button.contains(document.elementFromPoint(x, y)),
  }));
}, PICKER_SELECTOR);

/** True when at least one emoji is shown and every shown one is the topmost element at its centre. */
async function pickerOnTop(page) {
  const shown = await shownPickerButtons(page);
  return shown.length > 0 && shown.every(({ onTop }) => onTop);
}

/** The button and its open picker stay inside the viewport, clear of the rail, zoom bar, minimap and selection toolbar. */
async function checkPlacement(page, viewport) {
  const dock = await visibleBox(page, DOCK_SELECTOR);
  if (!dock) throw new Error(`${viewport.name}: reaction button not visible`);
  const picker = await visibleBox(page, PICKER_SELECTOR);
  const inside = (box) => box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  if (!inside(dock) || (picker && !inside(picker))) throw new Error(`${viewport.name}: button or picker leaves the viewport`);
  const overlaps = [];
  for (const selector of CHROME_SELECTORS) {
    const box = await visibleBox(page, selector);
    if (box && intersects(dock, box)) overlaps.push(`button/${selector}`);
    if (box && picker && intersects(picker, box)) overlaps.push(`picker/${selector}`);
  }
  if (overlaps.length) throw new Error(`${viewport.name}: overlaps ${overlaps.join(', ')}`);
  if (picker && !await pickerOnTop(page)) throw new Error(`${viewport.name}: another element covers the open picker`);
  return { dock, picker };
}

async function fireworksStep({ a, b, report }) {
  const seconds = FIREWORKS_DURATION_MS / MS_PER_SECOND;
  await step(report, `${mode}: A sends 🎆 and B sees full-screen fireworks that end by about ${seconds} s`, async () => {
    await recordDeliveries(a);
    await recordDeliveries(b);
    await react(a, 'en', FIREWORKS);
    await b.locator(FIREWORKS_SELECTOR).waitFor({ state: 'attached', timeout: SYNC_TIMEOUT_MS });
    const shownAt = Date.now();
    const firstPaintOnB = await waitForPaint(b);
    await sleep(FIREWORKS_SNAP_DELAY_MS);
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

/** B is watching A's fireworks when it turns on reduced motion; returns how long the show took to stop. */
async function stopShowMidway(a, b) {
  await waitForCooldown();
  await react(a, 'en', FIREWORKS);
  await b.locator(FIREWORKS_SELECTOR).waitFor({ state: 'attached', timeout: SYNC_TIMEOUT_MS });
  await waitForPaint(b);
  const switchedAt = Date.now();
  await b.emulateMedia({ reducedMotion: 'reduce' });
  await b.locator(FIREWORKS_SELECTOR).waitFor({ state: 'detached', timeout: MOTION_STOP_TIMEOUT_MS });
  return Date.now() - switchedAt;
}

async function reducedMotionStep({ a, b, report }) {
  await step(report, `${mode}: reduced motion stops a running show at once, then B gets still, non-flashing badges`, async () => {
    const stoppedAfterMs = await stopShowMidway(a, b);
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
    return { stoppedAfterMs, animation, canvases, box: first };
  });
}

/** Closes the open picker; on a phone the zoom controls it displaced must come back. */
async function closePicker(page, viewport) {
  await page.getByRole('button', { name: LABELS.en.open, exact: true }).click();
  await page.locator(PICKER_SELECTOR).waitFor({ state: 'detached' });
  if (viewport.phone && !await page.locator(ZOOM_SELECTOR).isVisible()) {
    throw new Error(`${viewport.name}: zoom controls did not return after the picker closed`);
  }
}

/** Opens the picker in `viewport`, checks its placement and captures it; `selected` puts the selection toolbar up first. */
async function placementWith(page, viewport, selected, report) {
  await page.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
  if (selected) {
    await page.keyboard.press('ControlOrMeta+a');
    await page.locator(SELECTION_TOOLBAR_SELECTOR).first().waitFor();
  }
  await openPicker(page, 'en');
  const placement = await checkPlacement(page, viewport);
  await snap(page, `${mode}-layout-${viewport.name}${selected ? '-selected' : ''}-en.png`, report);
  await closePicker(page, viewport);
  return placement;
}

async function layoutStep({ a, report }) {
  await step(report, `${mode}: the button and open picker stay clear of the rail, zoom bar, minimap and selection toolbar`, async () => {
    const results = {};
    for (const viewport of LAYOUT_VIEWPORTS) {
      await a.setViewportSize({ width: viewport.width, height: viewport.height });
      await sleep(SETTLE_MS);
      results[viewport.name] = {
        idle: await placementWith(a, viewport, false, report),
        selected: await placementWith(a, viewport, true, report),
      };
    }
    await a.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
    await a.setViewportSize(VIEWPORT);
    return results;
  });
}

/** A one-finger tap through the browser's touch input, not a mouse click. */
async function touchTap(cdp, { x, y }) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Swipes the open picker to its end with a touch gesture; returns the button the finger can now reach last. */
async function swipePickerToEnd(page, cdp) {
  const picker = page.locator(PICKER_SELECTOR);
  const box = await picker.boundingBox();
  const scrollWidth = await picker.evaluate((node) => node.scrollWidth);
  // A negative distance moves the content left, bringing the row's end into view.
  await cdp.send('Input.synthesizeScrollGesture', {
    x: box.x + box.width / 2, y: box.y + box.height / 2, xDistance: -scrollWidth, yDistance: 0, gestureSourceType: 'touch',
  });
  return (await shownPickerButtons(page)).at(-1);
}

async function touchScrollStep({ a, b, report }) {
  await step(report, `${mode}: on a 320 px phone a touch swipe reaches the last emoji and a tap on it sends`, async () => {
    const viewport = TOUCH_SCROLL_VIEWPORT;
    await a.setViewportSize({ width: viewport.width, height: viewport.height });
    await sleep(SETTLE_MS);
    await a.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
    await openPicker(a, 'en');
    const before = (await shownPickerButtons(a)).map(({ emoji }) => emoji);
    if (before.includes(LAST_REACTION)) throw new Error(`${viewport.name}: the whole row fits, so nothing to scroll`);
    const cdp = await a.context().newCDPSession(a);
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      const last = await swipePickerToEnd(a, cdp);
      await snap(a, `${mode}-touch-scroll-${viewport.name}-en.png`, report);
      if (last?.emoji !== LAST_REACTION || !last.onTop) throw new Error(`after the swipe the row ends at ${JSON.stringify(last)}`);
      await waitForCooldown();
      await touchTap(cdp, last);
      await b.locator(FLOAT_SELECTOR).filter({ hasText: NAME_A }).filter({ hasText: LAST_REACTION }).waitFor({ timeout: SYNC_TIMEOUT_MS });
      return { shownBefore: before, reached: last.emoji };
    } finally {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.detach();
      await a.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
      await a.setViewportSize(VIEWPORT);
    }
  });
}

async function drawingStep({ a, report }) {
  await step(report, `${mode}: on a phone the drawing toolbar takes the bottom row and the button steps aside`, async () => {
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
    if (!hidden || !back) throw new Error(`button hidden while drawing: ${hidden}, back after: ${back}`);
    return { hiddenWhileDrawing: hidden, visibleAfter: back };
  });
}

await runLiveCheck('board-reactions-live-check.mjs', async (context) => {
  await fireworksStep(context);
  await floatStep(context);
  await spamStep(context);
  await undoStep(context);
  await reducedMotionStep(context);
  await layoutStep(context);
  await touchScrollStep(context);
  await drawingStep(context);
  await errorsStep(context, mode);
}, liveSetupFor(mode, password));
