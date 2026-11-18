#!/usr/bin/env node
/**
 * Two-context live check of the card-writing countdown (A English, the admin; B Thai) using global Playwright.
 * Plain board: start isolated servers as in ui-live-check.mjs's header (free ports, db/uploads under the output), then
 *   node scripts/writing-timer-live-check.mjs http://localhost:<vite> <BaseData output>
 * Locked (end-to-end encrypted) board: start the fake Google and a sign-in relay as in room-lock-live-check.mjs's
 * header, then pass `locked` as the third argument; A signs in, creates a password-protected board, B unlocks it.
 * Leave YJS_ROOM_SESSION_TTL_SECONDS at its default: B's clock runs 2 minutes ahead, and a room session shorter than
 * that already looks expired to B when it reopens the board.
 * B reloads mid-run (a late join), then runs its clock 2 minutes ahead (Playwright's page clock) for the rest of the
 * run, so the +1, the expiry and the reopened board are checked across machines whose clocks disagree.
 * Run it under a hard timeout: the expiry step waits out a real 1-minute timer. Screenshots and report.json stay in
 * the output.
 */
import { randomBytes } from 'node:crypto';
import { CHIME_TONES_HZ } from '../src/client/writing-timer/chime.js';
import { MINUTE_MS } from '../src/domain/countdown.js';
import { TIMES_UP_SHOW_MS, WRITING_TIMER_EXTEND_MINUTES } from '../src/domain/writing-timer.js';
import {
  CANVAS_SELECTOR, LAYOUT_VIEWPORTS, NAME_B, REDO_KEY, SYNC_TIMEOUT_MS, VIEWPORT, addSharedSticky, enter, intersects,
  lockedBoard, runLiveCheck, shot, step, undoUntilHidden, unlockScreen, visibleBox, waitForTextOn,
} from './board-live-helpers.mjs';

const MODE = Object.freeze({ PLAIN: 'plain', LOCKED: 'locked' });
const mode = process.argv[4] ?? MODE.PLAIN;
if (!Object.values(MODE).includes(mode)) throw new Error(`mode must be ${Object.values(MODE).join(' or ')}`);

const LABELS = Object.freeze({
  en: {
    open: 'Card-writing timer', custom: 'Custom (minutes)', start: 'Start', stop: 'Stop timer', extend: '+1m',
    timesUp: "Time's up", reactions: 'Send a reaction to everyone',
  },
  th: { open: 'จับเวลาเขียนการ์ด', timesUp: 'หมดเวลา' },
});
const presetLabel = (minutes) => `${minutes} min`;
const TIMER_SELECTOR = '.rb-writing-timer';
const RUNNING_SELECTOR = `${TIMER_SELECTOR}[data-phase="running"]`;
const TIMES_UP_SELECTOR = `${TIMER_SELECTOR}[data-phase="timesUp"]`;
const TIME_SELECTOR = '.rb-writing-timer__time';
const START_SELECTOR = '.rb-writing-timer-start';
const SETUP_SELECTOR = '.rb-writing-timer-setup';
const MINIMAP_SELECTOR = '.rb-minimap';
const SELECTION_TOOLBAR_SELECTOR = '.rb-selection-toolbar';
const PICKER_SELECTOR = '.rb-reaction-picker';
const DRAW_TOOL_SELECTOR = '[data-tool="draw"]';
const STICKY_TOOL_SELECTOR = '[data-tool="sticky"]';
const DRAWING_TOOLBAR_SELECTOR = '.rb-drawing-toolbar';
const PHONE_EDITOR_SELECTOR = '.rb-mobile-editor__input';
// Everything the countdown must stay clear of at the bottom of the screen and down the left.
const CHROME_SELECTORS = Object.freeze([
  '.rb-reaction-dock', PICKER_SELECTOR, '.rb-zoom-controls', MINIMAP_SELECTOR, '.rb-tool-dock__body',
  SELECTION_TOOLBAR_SELECTOR,
]);
const START_MINUTES = 3;
const EXPIRY_MINUTES = 1;
const SECONDS_PER_MINUTE = 60;
const SECOND_MS = 1000;
// Both pages read their clock in the same instant; each label rounds a started second up.
const SAME_TIME_TOLERANCE_S = 1;
// +1 must show as about a minute more on the other page, whatever else ticked meanwhile.
const EXTEND_MIN_GAIN_S = 55;
const SECONDS_POLL_MS = 200;
const EXTENDED_RUN_S = (START_MINUTES + WRITING_TIMER_EXTEND_MINUTES) * SECONDS_PER_MINUTE;
// A reload wrongly counted as a live receipt would show the whole run written at the +1; B reloads only once this
// much has passed since then, so that error shows.
const LATE_JOIN_MIN_ELAPSED_S = 10;
// From the skew step on, B's machine clock reads this far ahead of A's.
const B_CLOCK_AHEAD_MS = 2 * MINUTE_MS;
const B_CLOCK_AHEAD_S = B_CLOCK_AHEAD_MS / MINUTE_MS * SECONDS_PER_MINUTE;
// B redraws its countdown within a second of its clock jumping.
const CLOCK_JUMP_SETTLE_MS = 1500;
// Long enough for a stale countdown or chime to show on a reopened board.
const STALE_WATCH_MS = 1500;
const EXPIRY_TIMEOUT_MS = EXPIRY_MINUTES * MINUTE_MS + SYNC_TIMEOUT_MS;
const TIMES_UP_END_TIMEOUT_MS = TIMES_UP_SHOW_MS + SYNC_TIMEOUT_MS;
const SETTLE_MS = 400;
const STICKY_PX = Object.freeze({ x: 520, y: 380 });
// Empty board in every layout viewport: right of the phone rail, under the top bar, left of the sticky.
const LAYOUT_EMPTY_PX = Object.freeze({ x: 200, y: 180 });
const PHONE_390 = LAYOUT_VIEWPORTS.find(({ name }) => name === 'phone-390');
// Empty board on the 390 px phone below the card the phone step adds: tapping it ends the editing.
const PHONE_EMPTY_PX = Object.freeze({ x: 200, y: 700 });
const STICKY_TEXT = `writing-timer-undo-${Date.now()}`;
const PHONE_CARD_TEXT = `writing-timer-phone-${Date.now()}`;
const password = `writing-timer-${randomBytes(9).toString('base64url')}`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const snap = (page, name, report) => shot(page, `${mode}-${name}.png`, report);

async function secondsLeft(page) {
  const [minutes, seconds] = (await page.locator(TIME_SELECTOR).textContent()).split(':').map(Number);
  return minutes * SECONDS_PER_MINUTE + seconds;
}

/** Both pages' remaining seconds, read together. */
const bothSecondsLeft = (a, b) => Promise.all([secondsLeft(a), secondsLeft(b)]);

/** Waits until `page` shows at least `floor` seconds left. */
async function waitForSecondsLeft(page, floor) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  while (await secondsLeft(page) < floor) {
    if (Date.now() > deadline) throw new Error(`the countdown never reached ${floor} s`);
    await sleep(SECONDS_POLL_MS);
  }
}

function countChimeTones() {
  window.__rbChimeTones = 0;
  const original = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function countedOscillator() {
    window.__rbChimeTones += 1;
    return original.call(this);
  };
}

/** Counts the chime's oscillators from here on, on this page and after every reload. */
async function countChimes(page) {
  await page.addInitScript(countChimeTones);
  await page.evaluate(countChimeTones);
}
const chimesOn = async (page) => (await page.evaluate(() => window.__rbChimeTones)) / CHIME_TONES_HZ.length;

async function openSetup(page) {
  await page.getByRole('button', { name: LABELS.en.open, exact: true }).click();
  await page.getByRole('dialog', { name: LABELS.en.open, exact: true }).waitFor();
}

async function startPreset(page, minutes) {
  await openSetup(page);
  await page.getByRole('button', { name: presetLabel(minutes), exact: true }).click();
  await page.locator(RUNNING_SELECTOR).waitFor();
}

async function startCustom(page, minutes) {
  await openSetup(page);
  await page.getByRole('spinbutton', { name: LABELS.en.custom, exact: true }).fill(String(minutes));
  await page.getByRole('button', { name: LABELS.en.start, exact: true }).click();
  await page.locator(RUNNING_SELECTOR).waitFor();
}

async function adminOnlyStep({ a, b, report }) {
  await step(report, `${mode}: only the admin (A) gets the start control`, async () => {
    await a.locator(START_SELECTOR).waitFor();
    await sleep(SETTLE_MS);
    const memberControls = await b.locator(START_SELECTOR).count();
    if (memberControls !== 0) throw new Error(`B has ${memberControls} start controls`);
    return { adminControl: true, memberControls };
  });
}

async function startStep({ a, b, report }) {
  await step(report, `${mode}: A starts ${START_MINUTES} min and B sees the same time left`, async () => {
    await Promise.all([countChimes(a), countChimes(b)]);
    await startPreset(a, START_MINUTES);
    await b.locator(RUNNING_SELECTOR).waitFor({ timeout: SYNC_TIMEOUT_MS });
    const [atA, atB] = await bothSecondsLeft(a, b);
    if (Math.abs(atA - atB) > SAME_TIME_TOLERANCE_S) throw new Error(`A shows ${atA} s, B ${atB} s`);
    if (atA > START_MINUTES * SECONDS_PER_MINUTE || atA < START_MINUTES * SECONDS_PER_MINUTE - SECONDS_PER_MINUTE / 2) {
      throw new Error(`A shows ${atA} s for a ${START_MINUTES}-minute timer`);
    }
    await snap(a, 'running-desktop-en', report);
    await snap(b, 'running-desktop-th', report);
    return { secondsAtA: atA, secondsAtB: atB };
  });
}

async function extendStep({ a, b, report }) {
  await step(report, `${mode}: A adds +1 and B's countdown gains a minute`, async () => {
    const before = await secondsLeft(b);
    await a.getByRole('button', { name: LABELS.en.extend, exact: true }).click();
    await waitForSecondsLeft(b, before + EXTEND_MIN_GAIN_S);
    const [atA, atB] = await bothSecondsLeft(a, b);
    if (Math.abs(atA - atB) > SAME_TIME_TOLERANCE_S) throw new Error(`after +1 A shows ${atA} s, B ${atB} s`);
    return { before, secondsAtA: atA, secondsAtB: atB };
  });
}

async function undoStep({ a, b, report }) {
  await step(report, `${mode}: the timer is not in undo; undo/redo of a sticky still syncs and leaves it running`, async () => {
    if (await a.evaluate(() => window.storage.canUndo())) throw new Error('starting or extending the timer entered undo');
    await addSharedSticky(a, 'en', STICKY_TEXT, STICKY_PX);
    await waitForTextOn([a, b], STICKY_TEXT);
    await a.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
    const presses = await undoUntilHidden(a, STICKY_TEXT);
    await waitForTextOn([b], STICKY_TEXT, 'hidden');
    for (let press = 0; press < presses; press += 1) await a.keyboard.press(REDO_KEY);
    await waitForTextOn([a, b], STICKY_TEXT);
    for (const page of [a, b]) await page.locator(RUNNING_SELECTOR).waitFor({ timeout: SYNC_TIMEOUT_MS });
    return { undoPresses: presses, stillRunning: true };
  });
}

// What the layout steps check: the shared countdown, and the admin's start button (with its setup) when idle.
const SUBJECT = Object.freeze({
  COUNTDOWN: { name: 'countdown', selector: TIMER_SELECTOR },
  START: { name: 'start', selector: START_SELECTOR },
});

/** `selector`'s box stays inside the viewport and clear of every bottom and rail chrome box. */
async function checkClearance(page, viewport, state, selector) {
  const subject = await visibleBox(page, selector);
  if (!subject) throw new Error(`${viewport.name} ${state}: ${selector} not visible`);
  const inside = subject.x >= 0 && subject.y >= 0 && subject.x + subject.width <= viewport.width
    && subject.y + subject.height <= viewport.height;
  if (!inside) throw new Error(`${viewport.name} ${state}: ${selector} leaves the viewport`);
  const overlaps = [];
  for (const chrome of CHROME_SELECTORS) {
    const box = await visibleBox(page, chrome);
    if (box && intersects(subject, box)) overlaps.push(chrome);
  }
  if (overlaps.length) throw new Error(`${viewport.name} ${state}: ${selector} overlaps ${overlaps.join(', ')}`);
  return subject;
}

async function toggleSetup(page, open) {
  await page.getByRole('button', { name: LABELS.en.open, exact: true }).click();
  await page.locator(SETUP_SELECTOR).waitFor({ state: open ? 'visible' : 'detached' });
}

async function toggleReactionPicker(page, open) {
  await page.getByRole('button', { name: LABELS.en.reactions, exact: true }).click();
  await page.locator(PICKER_SELECTOR).waitFor({ state: open ? 'visible' : 'detached' });
}

/** The admin's setup opens inside the viewport, clear of the chrome (the minimap steps aside on phones). */
async function setupIn(page, viewport, report) {
  await toggleSetup(page, true);
  const setup = await checkClearance(page, viewport, 'setup open', SETUP_SELECTOR);
  await snap(page, `layout-${viewport.name}-setup-en`, report);
  await toggleSetup(page, false);
  return setup;
}

/** Nothing selected, then everything selected with the 🎉 picker open: the busiest bottom of the screen. */
async function layoutIn(page, viewport, report, subject) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await sleep(SETTLE_MS);
  await page.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
  const plain = await checkClearance(page, viewport, 'nothing selected', subject.selector);
  const countdown = subject === SUBJECT.COUNTDOWN;
  const minimapHidden = countdown && viewport.phone ? !await page.locator(MINIMAP_SELECTOR).isVisible() : null;
  if (minimapHidden === false) throw new Error(`${viewport.name}: the minimap stays up beside the countdown`);
  await snap(page, `layout-${viewport.name}-${subject.name}-en`, report);
  const setup = countdown ? null : await setupIn(page, viewport, report);
  await page.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
  await page.keyboard.press('ControlOrMeta+a');
  await page.locator(SELECTION_TOOLBAR_SELECTOR).first().waitFor();
  await toggleReactionPicker(page, true);
  const busy = await checkClearance(page, viewport, 'selected + picker', subject.selector);
  await snap(page, `layout-${viewport.name}-${subject.name}-selected-picker-en`, report);
  await toggleReactionPicker(page, false);
  await page.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
  return { plain, busy, setup, minimapHidden };
}

async function layoutAcross(page, report, subject) {
  const results = {};
  for (const viewport of LAYOUT_VIEWPORTS) results[viewport.name] = await layoutIn(page, viewport, report, subject);
  await page.setViewportSize(VIEWPORT);
  return results;
}

const CLEARANCE = 'clear of the 🎉 pill and picker, zoom bar, minimap, rail and selection toolbar';

async function layoutStep({ a, b, report }) {
  await step(report, `${mode}: the countdown stays ${CLEARANCE}`, async () => {
    const results = await layoutAcross(a, report, SUBJECT.COUNTDOWN);
    await b.setViewportSize({ width: PHONE_390.width, height: PHONE_390.height });
    await sleep(SETTLE_MS);
    results.memberPhone = await checkClearance(b, PHONE_390, 'member', TIMER_SELECTOR);
    await snap(b, 'layout-phone-390-countdown-th', report);
    await b.setViewportSize(VIEWPORT);
    return results;
  });
}

async function startLayoutStep({ a, report }) {
  await step(report, `${mode}: the admin's start button and its setup stay ${CLEARANCE}`, () => layoutAcross(a, report, SUBJECT.START));
}

/** B reloads the board (unlocking a locked one again) and taps it, as a member coming back would. */
async function reopenB(b) {
  await b.reload();
  if (mode === MODE.LOCKED) await unlockScreen(b, 'th', password, NAME_B);
  else await enter(b, 'th', NAME_B);
  // Browsers let a page make sound only after the user has interacted with it.
  await b.locator(CANVAS_SELECTOR).click({ position: LAYOUT_EMPTY_PX });
}

async function phoneBusyStep({ a, report }) {
  await step(report, `${mode}: on a phone the countdown steps aside while drawing or typing a card`, async () => {
    await a.setViewportSize({ width: PHONE_390.width, height: PHONE_390.height });
    await a.keyboard.press('Escape');
    await a.locator(DRAW_TOOL_SELECTOR).click();
    await a.locator(DRAWING_TOOLBAR_SELECTOR).waitFor();
    await a.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)).opacity === '1', DRAWING_TOOLBAR_SELECTOR);
    const hiddenWhileDrawing = !await a.locator(TIMER_SELECTOR).isVisible();
    await snap(a, 'drawing-phone-390-en', report);
    await a.locator(DRAW_TOOL_SELECTOR).click();
    await a.locator(DRAWING_TOOLBAR_SELECTOR).waitFor({ state: 'detached' });
    await a.locator(STICKY_TOOL_SELECTOR).click();
    const editor = a.locator(PHONE_EDITOR_SELECTOR);
    await editor.fill(PHONE_CARD_TEXT);
    const hiddenWhileTyping = !await a.locator(TIMER_SELECTOR).isVisible();
    await snap(a, 'typing-phone-390-en', report);
    await a.locator(CANVAS_SELECTOR).click({ position: PHONE_EMPTY_PX });
    await a.waitForFunction((selector) => !document.querySelector(`${selector}:focus`), PHONE_EDITOR_SELECTOR);
    const back = await a.locator(RUNNING_SELECTOR).isVisible();
    await a.setViewportSize(VIEWPORT);
    if (!hiddenWhileDrawing || !hiddenWhileTyping || !back) {
      throw new Error(`hidden while drawing ${hiddenWhileDrawing}, while typing ${hiddenWhileTyping}; back after ${back}`);
    }
    return { hiddenWhileDrawing, hiddenWhileTyping, visibleAfter: back };
  });
}

async function lateJoinStep({ a, b, report }) {
  await step(report, `${mode}: B reloads mid-run (a late join) and shows the same time left as A`, async () => {
    const shortByS = LATE_JOIN_MIN_ELAPSED_S - (EXTENDED_RUN_S - await secondsLeft(a));
    if (shortByS > 0) await sleep(shortByS * SECOND_MS);
    await reopenB(b);
    await b.locator(RUNNING_SELECTOR).waitFor({ timeout: SYNC_TIMEOUT_MS });
    const [atA, atB] = await bothSecondsLeft(a, b);
    if (Math.abs(atA - atB) > SAME_TIME_TOLERANCE_S) throw new Error(`after B's reload A shows ${atA} s, B ${atB} s`);
    return { sinceExtendS: EXTENDED_RUN_S - atA, secondsAtA: atA, secondsAtB: atB };
  });
}

async function skewStep({ a, b, report }) {
  await step(report, `${mode}: with B's clock ${B_CLOCK_AHEAD_S} s ahead, A's +1 shows the same time left on both`, async () => {
    await b.clock.install({ time: Date.now() + B_CLOCK_AHEAD_MS });
    await b.clock.resume();
    await sleep(CLOCK_JUMP_SETTLE_MS);
    const [aBefore, bBefore] = await bothSecondsLeft(a, b);
    const jumpS = aBefore - bBefore;
    if (Math.abs(jumpS - B_CLOCK_AHEAD_S) > SAME_TIME_TOLERANCE_S) throw new Error(`B's clock jumped ${jumpS} s, not ${B_CLOCK_AHEAD_S} s`);
    await a.getByRole('button', { name: LABELS.en.extend, exact: true }).click();
    await waitForSecondsLeft(b, aBefore + EXTEND_MIN_GAIN_S);
    const [atA, atB] = await bothSecondsLeft(a, b);
    if (Math.abs(atA - atB) > SAME_TIME_TOLERANCE_S) throw new Error(`with B's clock ahead A shows ${atA} s, B ${atB} s`);
    return { jumpS, secondsAtA: atA, secondsAtB: atB };
  });
}

async function stopStep({ a, b, report }) {
  await step(report, `${mode}: A stops the timer and it disappears on both`, async () => {
    await a.getByRole('button', { name: LABELS.en.stop, exact: true }).click();
    for (const page of [a, b]) await page.locator(TIMER_SELECTOR).waitFor({ state: 'detached', timeout: SYNC_TIMEOUT_MS });
    await a.locator(START_SELECTOR).waitFor();
    return { stopped: true };
  });
}

async function expiryStep({ a, b, report }) {
  await step(report, `${mode}: a ${EXPIRY_MINUTES}-minute timer ends with Time's up and one chime on both, then goes`, async () => {
    await startCustom(a, EXPIRY_MINUTES);
    await b.locator(RUNNING_SELECTOR).waitFor({ timeout: SYNC_TIMEOUT_MS });
    await b.setViewportSize({ width: PHONE_390.width, height: PHONE_390.height });
    await Promise.all([a, b].map((page) => page.locator(TIMES_UP_SELECTOR).waitFor({ timeout: EXPIRY_TIMEOUT_MS })));
    const texts = await Promise.all([a, b].map((page) => page.locator(TIMES_UP_SELECTOR).textContent()));
    await snap(a, 'times-up-desktop-en', report);
    await snap(b, 'times-up-phone-390-th', report);
    if (texts[0] !== LABELS.en.timesUp || texts[1] !== LABELS.th.timesUp) throw new Error(`Time's up reads ${JSON.stringify(texts)}`);
    await Promise.all([a, b].map((page) => page.locator(TIMER_SELECTOR).waitFor({ state: 'detached', timeout: TIMES_UP_END_TIMEOUT_MS })));
    const chimes = await Promise.all([chimesOn(a), chimesOn(b)]);
    await b.setViewportSize(VIEWPORT);
    if (chimes.some((count) => count !== 1)) throw new Error(`chimes played: A ${chimes[0]}, B ${chimes[1]}`);
    await a.locator(START_SELECTOR).waitFor();
    return { texts, chimes };
  });
}

async function reopenAfterEndStep({ b, report }) {
  await step(report, `${mode}: B reopening the board after the end shows no countdown and plays nothing`, async () => {
    await reopenB(b);
    await sleep(STALE_WATCH_MS);
    const shown = await b.locator(TIMER_SELECTOR).count();
    const chimes = await chimesOn(b);
    if (shown || chimes) throw new Error(`the reopened board shows ${shown} countdowns and played ${chimes} chimes`);
    return { shown, chimes };
  });
}

async function errorsStep({ report }) {
  await step(report, `${mode}: no page errors`, async () => {
    if (report.pageErrors.length) throw new Error(JSON.stringify(report.pageErrors));
    return { consoleErrors: report.consoleErrors.length };
  });
}

await runLiveCheck('writing-timer-live-check.mjs', async (context) => {
  await adminOnlyStep(context);
  await startStep(context);
  await extendStep(context);
  await undoStep(context);
  await layoutStep(context);
  await phoneBusyStep(context);
  await lateJoinStep(context);
  await skewStep(context);
  await stopStep(context);
  await startLayoutStep(context);
  await expiryStep(context);
  await reopenAfterEndStep(context);
  await errorsStep(context);
}, mode === MODE.LOCKED ? { setup: (browser, baseUrl, report) => lockedBoard(browser, baseUrl, report, password) } : {});
