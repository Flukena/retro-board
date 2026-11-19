#!/usr/bin/env node
/**
 * Two-participant live check of undo while a drag is held and while editing is locked (INV-3, INV-7; refactor design
 * §7.3). English A drags a shared sticky and presses undo with the mouse still down: the board refuses with the
 * "release the drag" toast and nothing is reverted. After the mouse is released undo reverts the drag on both pages.
 * A second drag that ends only through a window `blur` (no mouse-up) must not leak the drag lock: undo works at once.
 * Then Thai B's undo is refused with the "editing locked" toast while A has locked editing, and works after unlocking.
 * Run it through the runner, which starts an isolated relay and Vite:
 * node scripts/live-check-all.mjs --only board-undo-middrag --out-root <fresh BaseData dir>
 * or directly: node scripts/board-undo-middrag-live-check.mjs <base-url> <BaseData output directory>
 */
import assert from 'node:assert/strict';
import {
  LIVE_MODE, UNDO_KEY, addSharedSticky, appLabel, boardItems, boxCenter, dragBy, errorsStep, itemById, pollUntil,
  runLiveCheck, sleep, step, stickyBox, waitForTextOn, withinPx,
} from './board-live-helpers.mjs';

const UNDOABLE_TEXT = 'ut';
const LOCKED_TEXT = 'bt';
const UNDOABLE_ADD_PX = Object.freeze({ x: 480, y: 360 });
const LOCKED_ADD_PX = Object.freeze({ x: 960, y: 360 });
// Well past the 4 px drag threshold, and clear of the bottom-right zoom controls.
const FIRST_DRAG_PX = Object.freeze({ x: 120, y: 80 });
const SECOND_DRAG_PX = Object.freeze({ x: 100, y: 60 });
// The bridge's Y.UndoManager captureTimeout (storage-bridge.js) is 500 ms: edits closer together are one undo step.
// A pause of twice that keeps the add, each drag and each undo apart.
const UNDO_SETTLE_MS = 1_000;
const TOAST_VISIBLE_TIMEOUT_MS = 5_000;
// The toast hides after 3200 ms (RetroBoard.jsx); the wait for it to vanish allows that plus slack.
const TOAST_HIDDEN_TIMEOUT_MS = 6_000;
// A toast that would appear after the key press shows within this window, which is shorter than its 3200 ms life.
const NO_TOAST_WINDOW_MS = 1_500;
const POSITION_TOLERANCE_WORLD_PX = 0.5;
const MOVED_MIN_WORLD_PX = 10;

const STEP_NAMES = Object.freeze({
  undoable: 'A has an undoable sticky',
  refused: 'undo is refused mid-drag',
  released: 'releasing the mouse allows undo again',
  blur: 'a drag that ends by window blur does not leak the drag lock',
  locked: 'non-admin undo is refused while editing is locked',
  unlocked: 'unlocking lets B undo',
});

const finishDragToast = (page) => page.getByText(appLabel('en', 'topbar.finishDragFirst'), { exact: true });
const lockedToast = (page) => page.getByText(appLabel('th', 'common.warnLockEdit'), { exact: true });
const canUndo = (page) => page.evaluate(() => window.storage.canUndo());
const pointOf = (item) => ({ x: item.x, y: item.y });
const isAt = (item, point) => Boolean(item) && withinPx(item.x, point.x, POSITION_TOLERANCE_WORLD_PX)
  && withinPx(item.y, point.y, POSITION_TOLERANCE_WORLD_PX);

/** Each page's canonical copy of the item `id`, read through `window.storage` (the Yjs doc). */
const readOn = (pages, id) => Promise.all(pages.map(async (page) => itemById(await boardItems(page), id)));

const waitForPosition = (pages, id, point, what) => pollUntil(() => readOn(pages, id), (rows) => rows.every((row) => isAt(row, point)), what);

const stickyCentre = async (page, text) => boxCenter(await stickyBox(page, text));

/** Asserts the toast stays hidden for NO_TOAST_WINDOW_MS after the caller's key press. */
async function assertNoToast(toast, what) {
  await sleep(NO_TOAST_WINDOW_MS);
  assert.equal(await toast.isVisible(), false, `${what} showed a toast`);
}

/** Waits for the toast shown by an earlier step to vanish, so the next absence check starts from a clean screen. */
const waitToastGone = (toast) => toast.waitFor({ state: 'hidden', timeout: TOAST_HIDDEN_TIMEOUT_MS });

/** Holds the first drag of `ut` past the threshold; the caller releases the mouse. */
const holdDrag = async (page, by) => dragBy(page, await stickyCentre(page, UNDOABLE_TEXT), by, { hold: true });

/** Runs `gesture` with the mouse held, then releases the button in `finally` even when the gesture throws. */
async function whileHeld(page, by, gesture) {
  try {
    await holdDrag(page, by);
    return await gesture();
  } finally {
    await page.mouse.up();
  }
}

// ---------------------------------------------------------------- step 1

async function addUndoable({ a, b }, run) {
  await addSharedSticky(a, 'en', UNDOABLE_TEXT, UNDOABLE_ADD_PX);
  await waitForTextOn([a, b], UNDOABLE_TEXT);
  const added = (await boardItems(a)).find((item) => item.type === 'sticky' && item.text === UNDOABLE_TEXT);
  assert.ok(added, "A's board holds the sticky");
  run.id = added.id;
  run.start = pointOf(added);
  assert.equal(await canUndo(a), true, 'A cannot undo after adding a sticky');
  return { start: run.start };
}

// ---------------------------------------------------------------- step 2

async function undoRefusedMidDrag({ a, b }, run) {
  await sleep(UNDO_SETTLE_MS);
  return whileHeld(a, FIRST_DRAG_PX, async () => {
    await a.keyboard.press(UNDO_KEY);
    await finishDragToast(a).waitFor({ state: 'visible', timeout: TOAST_VISIBLE_TIMEOUT_MS });
    const rows = await readOn([a, b], run.id);
    assert.ok(rows.every(Boolean), 'ut vanished from a page when undo was pressed mid-drag');
    assert.equal(await canUndo(a), true, 'A lost its undo history to a refused undo');
    return { toast: appLabel('en', 'topbar.finishDragFirst') };
  });
}

// ---------------------------------------------------------------- step 3

async function releaseAllowsUndo({ a, b }, run) {
  const dragged = await waitForMoved([a, b], run);
  await waitToastGone(finishDragToast(a));
  await sleep(UNDO_SETTLE_MS);
  await a.keyboard.press(UNDO_KEY);
  await waitForPosition([a, b], run.id, run.start, 'undo did not return ut to its start on both pages');
  await assertNoToast(finishDragToast(a), 'undo after the release');
  return { dragged, restored: run.start };
}

/** Waits until the released drag is canonical on every page, away from the start; returns its end point. */
async function waitForMoved(pages, run) {
  const rows = await pollUntil(() => readOn(pages, run.id),
    (items) => items.every((item) => item && Math.hypot(item.x - run.start.x, item.y - run.start.y) > MOVED_MIN_WORLD_PX),
    'the released drag did not reach both pages');
  return pointOf(rows[0]);
}

// ---------------------------------------------------------------- step 4

async function blurDoesNotLeakDragLock({ a, b }, run) {
  await sleep(UNDO_SETTLE_MS);
  await whileHeld(a, SECOND_DRAG_PX, async () => {
    // The button stays down: only the window blur can end this drag.
    await a.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(UNDO_SETTLE_MS);
    await a.keyboard.press(UNDO_KEY);
    await waitForPosition([a, b], run.id, run.start, 'undo after a blur did not return ut to its start on both pages');
    await assertNoToast(finishDragToast(a), 'undo after a window blur');
  });
  return { restored: run.start };
}

// ---------------------------------------------------------------- steps 5-6

const lockButton = (page) => page.getByTitle(appLabel('en', 'topbar.lockEdit'), { exact: true });
// While editing is locked the button's title reads "Editing locked" (topbar.editingLocked); its visible label is the
// "Unlock editing" action (TopBar.jsx), so that label names the button.
const unlockButton = (page) => page.getByRole('button', { name: appLabel('en', 'topbar.unlockEdit'), exact: true });

const isEditingLocked = (page) => page.evaluate(async () => (await window.storage.get('boardState', true)).value.editingLocked === true);

async function undoRefusedWhileLocked({ a, b }) {
  await addSharedSticky(b, 'th', LOCKED_TEXT, LOCKED_ADD_PX);
  await waitForTextOn([a, b], LOCKED_TEXT);
  await sleep(UNDO_SETTLE_MS);
  await lockButton(a).click();
  await pollUntil(() => isEditingLocked(b), (locked) => locked, 'B never saw editing locked');
  await b.keyboard.press(UNDO_KEY);
  await lockedToast(b).waitFor({ state: 'visible', timeout: TOAST_VISIBLE_TIMEOUT_MS });
  await waitForTextOn([a, b], LOCKED_TEXT);
  return { toast: appLabel('th', 'common.warnLockEdit') };
}

async function unlockLetsUndo({ a, b }) {
  await unlockButton(a).click();
  await pollUntil(() => isEditingLocked(b), (locked) => !locked, 'B never saw editing unlocked');
  await waitToastGone(lockedToast(b));
  await b.keyboard.press(UNDO_KEY);
  await waitForTextOn([a, b], LOCKED_TEXT, 'hidden');
  return { removed: LOCKED_TEXT };
}

await runLiveCheck('board-undo-middrag-live-check.mjs', async (context) => {
  const run = {};
  const { report } = context;
  await step(report, STEP_NAMES.undoable, () => addUndoable(context, run));
  await step(report, STEP_NAMES.refused, () => undoRefusedMidDrag(context, run));
  await step(report, STEP_NAMES.released, () => releaseAllowsUndo(context, run));
  await step(report, STEP_NAMES.blur, () => blurDoesNotLeakDragLock(context, run));
  await step(report, STEP_NAMES.locked, () => undoRefusedWhileLocked(context));
  await step(report, STEP_NAMES.unlocked, () => unlockLetsUndo(context));
  await errorsStep(context, LIVE_MODE.PLAIN);
});
