#!/usr/bin/env node
/**
 * Two-participant live check of remote presence (INV-10, and the visible half of INV-11; refactor design §7.3).
 * Each participant sees the other's named cursor follow the mouse. A shared sticky `pres` shows B's selection label and
 * B's editing label on A, and both clear again. While B holds a drag of `pres`, A's own drag is refused with the "in use"
 * toast and moves nothing. When B leaves mid-drag the busy claim, B's cursor, selection and editing labels all clear on A
 * within PLAYER_PRESENCE_STALE_MS + SYNC_TIMEOUT_MS, and A's drag then succeeds with no busy toast. The measured clear
 * times are recorded in report.json.
 * Run it through the runner, which starts an isolated relay and Vite:
 * node scripts/live-check-all.mjs --only presence --out-root <fresh BaseData dir>
 * or directly: node scripts/presence-live-check.mjs <base-url> <BaseData output directory>
 */
import assert from 'node:assert/strict';
import { PLAYER_PRESENCE_STALE_MS } from '../src/domain/awareness-liveness.js';
import {
  LIVE_MODE, NAME_A, NAME_B, SYNC_TIMEOUT_MS, addSharedSticky, appLabel, boardItems, boxCenter, dragBy, errorsStep,
  itemById, pollUntil, runLiveCheck, sleep, step, stickyBox, waitForTextOn, withinPx,
} from './board-live-helpers.mjs';

const SHARED_TEXT = 'pres';
const SHARED_ADD_PX = Object.freeze({ x: 480, y: 360 });
// Two mouse points 300 px apart on the empty canvas, clear of the topbar and the bottom-right zoom controls.
const CURSOR_FROM_PX = Object.freeze({ x: 700, y: 520 });
const CURSOR_TO_PX = Object.freeze({ x: 1000, y: 520 });
const CURSOR_MOVE_STEPS = 10;
// The cursor is drawn in world units; 300 screen px at the default zoom is about 300 world px, so half is a safe floor.
const CURSOR_MIN_DELTA_WORLD_PX = 150;
const CURSOR_SETTLE_MS = 400;
// Empty canvas, away from every sticky and control.
const EMPTY_CANVAS_PX = Object.freeze({ x: 1000, y: 200 });
const FOCUSED_EDITOR_SELECTOR = 'textarea:focus';
const CARET_TO_END_KEY = 'End';
const TYPED_KEY = 'x';
const UNDO_TYPED_KEY = 'Backspace';
const LEAVE_EDITOR_KEY = 'Escape';
const BUSY_DRAG_PX = Object.freeze({ x: 120, y: 80 });
const PEER_DRAG_PX = Object.freeze({ x: 100, y: 60 });
const POSITION_TOLERANCE_WORLD_PX = 0.5;
const MOVED_MIN_WORLD_PX = 10;
const BUSY_SETTLE_MS = 500;
const TOAST_VISIBLE_TIMEOUT_MS = 5_000;
// The toast hides after 3200 ms (RetroBoard.jsx); the wait for it to vanish allows that plus slack.
const TOAST_HIDDEN_TIMEOUT_MS = 6_000;
// A toast that would appear after a gesture shows within this window, which is shorter than its 3200 ms life.
const NO_TOAST_WINDOW_MS = 1_500;
const LABEL_TIMEOUT_MS = SYNC_TIMEOUT_MS;
const LEAVE_CLEAR_BOUND_MS = PLAYER_PRESENCE_STALE_MS + SYNC_TIMEOUT_MS;
const BLANK_URL = 'about:blank';

const STEP_NAMES = Object.freeze({
  cursorA: "A sees B's cursor and its name",
  cursorB: "B sees A's cursor and its name",
  selection: 'selection label appears and clears',
  editing: 'editing indicator appears and clears',
  busy: 'busy claim blocks a peer drag and clears when the claimant leaves',
  gone: 'cursor, selection and editing indicators are gone for a departed peer',
});

const cursorOf = (page, name) => page.locator('.rb-player-cursor').filter({ hasText: name });
const selectionLabel = (page, name) => page.getByRole('status', { name: appLabel('en', 'selection.by', { name }), exact: true });
const editingLabel = (page, name) => page.getByRole('status', { name: appLabel('en', 'editing.by', { name }), exact: true });
const busyToast = (page) => page.getByText(appLabel('en', 'common.warnItemBusy'), { exact: true });
const hiddenWithin = (locator, what) => locator.waitFor({ state: 'hidden', timeout: LABEL_TIMEOUT_MS })
  .catch((error) => { throw new Error(`${what} did not clear: ${error.message}`); });
const visibleWithin = (locator) => locator.waitFor({ state: 'visible', timeout: LABEL_TIMEOUT_MS });
const stickyCentre = async (page) => boxCenter(await stickyBox(page, SHARED_TEXT));
const pointOf = (item) => ({ x: item.x, y: item.y });
const isAt = (item, point) => Boolean(item) && withinPx(item.x, point.x, POSITION_TOLERANCE_WORLD_PX)
  && withinPx(item.y, point.y, POSITION_TOLERANCE_WORLD_PX);
const readItem = async (page, id) => itemById(await boardItems(page), id);
const isRemoteBusy = (page, id) => page.evaluate((itemId) => Boolean(window.storage.findRemoteBusyItem([itemId])), id);

/** The data-cursor-x of the first cursor labelled `name`, or null while none is shown. */
async function cursorX(page, name) {
  const cursor = cursorOf(page, name).first();
  if (!await cursor.count()) return null;
  const raw = await cursor.getAttribute('data-cursor-x');
  return raw === null ? null : Number(raw);
}

/** Asserts the toast stays hidden for NO_TOAST_WINDOW_MS after the caller's gesture. */
async function assertNoToast(toast, what) {
  await sleep(NO_TOAST_WINDOW_MS);
  assert.equal(await toast.isVisible(), false, `${what} showed a toast`);
}

// ---------------------------------------------------------------- steps 1-2

/** `mover` moves over the canvas at two points 300 px apart; `watcher` must show the cursor named `name` following. */
async function cursorFollows(mover, watcher, name) {
  await mover.mouse.move(CURSOR_FROM_PX.x, CURSOR_FROM_PX.y, { steps: CURSOR_MOVE_STEPS });
  await pollUntil(() => cursorX(watcher, name), (x) => x !== null, `no cursor named ${name} appeared`);
  await sleep(CURSOR_SETTLE_MS);
  const first = await cursorX(watcher, name);
  await mover.mouse.move(CURSOR_TO_PX.x, CURSOR_TO_PX.y, { steps: CURSOR_MOVE_STEPS });
  const second = await pollUntil(() => cursorX(watcher, name), (x) => x !== null && x - first >= CURSOR_MIN_DELTA_WORLD_PX,
    `the cursor named ${name} did not follow the mouse 300 px right (first x ${first})`);
  await visibleWithin(cursorOf(watcher, name).first());
  return { name, firstX: first, secondX: second };
}

// ---------------------------------------------------------------- steps 3-4

async function selectionAppearsAndClears({ a, b }, run) {
  await addSharedSticky(a, 'en', SHARED_TEXT, SHARED_ADD_PX);
  await waitForTextOn([a, b], SHARED_TEXT);
  run.id = (await boardItems(a)).find((item) => item.type === 'sticky' && item.text === SHARED_TEXT).id;
  const label = selectionLabel(a, NAME_B);
  assert.equal(await label.count(), 0, 'B already shows a selection label before clicking');
  const centre = await stickyCentre(b);
  await b.mouse.click(centre.x, centre.y);
  await visibleWithin(label);
  await b.mouse.click(EMPTY_CANVAS_PX.x, EMPTY_CANVAS_PX.y);
  await hiddenWithin(label, 'the selection label');
  return { label: appLabel('en', 'selection.by', { name: NAME_B }) };
}

async function editingAppearsAndClears({ a, b }) {
  const label = editingLabel(a, NAME_B);
  assert.equal(await label.count(), 0, 'an editing label shows before B edits');
  const centre = await stickyCentre(b);
  await b.mouse.dblclick(centre.x, centre.y);
  // The editor takes focus a moment after the double-click; keys sent earlier would go nowhere or to the wrong place.
  const editor = b.locator(FOCUSED_EDITOR_SELECTOR);
  await editor.waitFor({ state: 'visible', timeout: LABEL_TIMEOUT_MS });
  await editor.press(CARET_TO_END_KEY);
  await editor.press(TYPED_KEY);
  try {
    await visibleWithin(label);
  } finally {
    await editor.press(UNDO_TYPED_KEY);
    await editor.press(LEAVE_EDITOR_KEY);
  }
  await hiddenWithin(label, 'the editing label');
  await b.mouse.click(EMPTY_CANVAS_PX.x, EMPTY_CANVAS_PX.y);
  return { label: appLabel('en', 'editing.by', { name: NAME_B }) };
}

// ---------------------------------------------------------------- steps 5-6

/** Runs `gesture` while B holds a drag of `pres`; B leaves its page mid-hold, so the later `mouse.up` meets a blank page. */
async function whileBHolds(b, gesture) {
  const centre = await stickyCentre(b);
  try {
    await dragBy(b, centre, BUSY_DRAG_PX, { hold: true });
    return await gesture();
  } finally {
    await b.mouse.up();
  }
}

/** B's busy claim plus its cursor, selection and editing labels, as counts on A; all zero once B is gone. */
const presenceOf = async (a, id) => ({
  busy: Number(await isRemoteBusy(a, id)),
  cursors: await cursorOf(a, NAME_B).count(),
  selection: await selectionLabel(a, NAME_B).count(),
  editing: await editingLabel(a, NAME_B).count(),
});
const isGone = (presence) => Object.values(presence).every((count) => count === 0);

/** Polls until every trace of B is gone from A; returns the time since `leftAt`, failing past LEAVE_CLEAR_BOUND_MS. */
async function waitForPeerGone(a, id, leftAt) {
  await pollUntil(() => presenceOf(a, id), isGone, "B's presence was still shown on A", LEAVE_CLEAR_BOUND_MS);
  return Date.now() - leftAt;
}

async function busyBlocksThenClears({ a, b }, run) {
  let blockedAt;
  await whileBHolds(b, async () => {
    await pollUntil(() => isRemoteBusy(a, run.id), (busy) => busy, "B's drag never claimed pres on A");
    await visibleWithin(cursorOf(a, NAME_B).first());
    await sleep(BUSY_SETTLE_MS);
    blockedAt = pointOf(await readItem(a, run.id));
    await dragBy(a, await stickyCentre(a), PEER_DRAG_PX);
    await busyToast(a).waitFor({ state: 'visible', timeout: TOAST_VISIBLE_TIMEOUT_MS });
    assert.ok(isAt(await readItem(a, run.id), blockedAt), "A's drag moved pres although B holds a claim on it");
    await b.goto(BLANK_URL);
    run.leftAt = Date.now();
    run.clearedMs = await waitForPeerGone(a, run.id, run.leftAt);
  });
  await busyToast(a).waitFor({ state: 'hidden', timeout: TOAST_HIDDEN_TIMEOUT_MS });
  const before = pointOf(await readItem(a, run.id));
  await dragBy(a, await stickyCentre(a), PEER_DRAG_PX);
  await pollUntil(() => readItem(a, run.id), (item) => Math.hypot(item.x - before.x, item.y - before.y) > MOVED_MIN_WORLD_PX,
    "A's drag of pres did not move it after B left");
  await assertNoToast(busyToast(a), "A's drag after B left");
  return { clearedMs: run.clearedMs, boundMs: LEAVE_CLEAR_BOUND_MS, blockedAt };
}

async function departedPeerIsGone({ a }, run) {
  assert.ok(run.clearedMs < LEAVE_CLEAR_BOUND_MS, `B's presence cleared after ${run.clearedMs} ms`);
  const remaining = await presenceOf(a, run.id);
  assert.ok(isGone(remaining), `B's presence returned on A: ${JSON.stringify(remaining)}`);
  return { clearedMs: run.clearedMs, boundMs: LEAVE_CLEAR_BOUND_MS };
}

await runLiveCheck('presence-live-check.mjs', async (context) => {
  const run = {};
  const { a, b, report } = context;
  await step(report, STEP_NAMES.cursorA, () => cursorFollows(b, a, NAME_B));
  await step(report, STEP_NAMES.cursorB, () => cursorFollows(a, b, NAME_A));
  await step(report, STEP_NAMES.selection, () => selectionAppearsAndClears(context, run));
  await step(report, STEP_NAMES.editing, () => editingAppearsAndClears(context));
  await step(report, STEP_NAMES.busy, () => busyBlocksThenClears(context, run));
  await step(report, STEP_NAMES.gone, () => departedPeerIsGone(context, run));
  await errorsStep(context, LIVE_MODE.PLAIN);
});
