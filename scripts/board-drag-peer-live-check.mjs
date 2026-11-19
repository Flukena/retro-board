#!/usr/bin/env node
/**
 * Two-participant live check of a drag while a peer edits (INV-5, INV-7, INV-2; refactor design §7.3).
 * English A drags one shared sticky while Thai B drags another and types into it. A's rendered card follows A's
 * pointer through every remote snapshot, B's text still reaches A mid-drag, both pages converge, A's card is not
 * snapped back inside the recent-move window, and A's undo/redo reverts only A's drag on both pages.
 * Run it through the runner, which starts an isolated relay and Vite:
 * node scripts/live-check-all.mjs --only board-drag-peer --out-root <fresh BaseData dir>
 * or directly: node scripts/board-drag-peer-live-check.mjs <base-url> <BaseData output directory>
 */
import assert from 'node:assert/strict';
import {
  LIVE_MODE, REDO_KEY, SYNC_TIMEOUT_MS, UNDO_KEY, addSharedSticky, boardItems, boxCenter, dragBy, errorsStep, itemById,
  runLiveCheck, shot, sleep, step, stickyBox, waitForTextOn, withinPx,
} from './board-live-helpers.mjs';

const ALPHA_TEXT = 'alpha';
const BETA_TEXT = 'beta';
// Each keystroke is a remote snapshot on A. 72 characters (the plan's 30, lengthened per its red-run rule) keep B
// typing through most of A's 40 steps; contains neither card's text.
const BETA_TYPING = ' was moved, then typed into by B while A was still dragging its own card';
const BETA_FINAL_TEXT = `${BETA_TEXT}${BETA_TYPING}`;
const BETA_KEY_DELAY_MS = 20;
const ALPHA_ADD_PX = Object.freeze({ x: 480, y: 360 });
const BETA_ADD_PX = Object.freeze({ x: 960, y: 360 });
const BETA_DRAG_PX = Object.freeze({ x: 100, y: 0 });
// 12 px across per pointer step (plan) and half that down, so the direction check has two non-zero axes and alpha
// ends below beta, inside the 1440x900 viewport.
const DRAG_STEP_PX = Object.freeze({ x: 12, y: 6 });
const DRAG_STEP_COUNT = 40;
const SAMPLE_INTERVAL_MS = 25;
const SNAP_TOLERANCE_PX = 4;
const CONVERGE_TOLERANCE_WORLD_PX = 0.5;
const DIRECTION_RATIO_TOLERANCE = 0.02;
const RECENT_MOVE_PROBE_WAIT_MS = 1_500;
// RetroBoard.jsx RECENT_MOVE_WINDOW_MS: a just-dropped card keeps its local geometry against stale peer echoes.
const RECENT_MOVE_WINDOW_MS = 8_000;
// Longer than the bridge's Y.UndoManager captureTimeout (500 ms, storage-bridge.js), so A's drag is its own undo
// step instead of merging into alpha's creation, which one undo would then delete.
const UNDO_CAPTURE_SETTLE_MS = 1_000;
const POLL_INTERVAL_MS = 100;
const DETAIL_DECIMALS = 1;
const LEAVE_EDITOR_KEY = 'Escape';

const STEP_NAMES = Object.freeze({
  add: 'both add a shared sticky',
  drag: 'A drags alpha while B drags beta and types, A is never snapped back',
  converge: 'peers converge after the drag',
  hold: `still not snapped back inside the ${RECENT_MOVE_WINDOW_MS} ms recent-move window`,
  undo: "undo on A reverts only A's drag, redo restores it, on both pages",
});

const rounded = (value) => Number(value.toFixed(DETAIL_DECIMALS));
const pointerAfter = (start, steps) => ({ x: start.x + steps * DRAG_STEP_PX.x, y: start.y + steps * DRAG_STEP_PX.y });
const nearPoint = (actual, expected, tolerance) => withinPx(actual.x, expected.x, tolerance) && withinPx(actual.y, expected.y, tolerance);
const sameWorldPoint = (actual, expected) => Boolean(actual && expected) && nearPoint(actual, expected, CONVERGE_TOLERANCE_WORLD_PX);
const worldPoint = (item) => ({ x: item.x, y: item.y });
const itemWithText = (items, text) => items.find((item) => item.text === text);

const stickySelector = (id) => `[data-sticky-id="${id}"]`;

/**
 * The rendered centre (page px) of the sticky `id`, read after two animation frames so React has committed what the
 * last input changed. The box is read in the same round trip, so a drag step stays close to a real pointer's rate.
 */
async function renderedCentre(page, id) {
  const box = await page.evaluate((selector) => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      resolve(rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null);
    }));
  }), stickySelector(id));
  if (!box) throw new Error(`sticky ${id} is not shown`);
  return boxCenter(box);
}

/** Polls `read` until `accept` holds for its value; fails with `message` and the last value after SYNC_TIMEOUT_MS. */
async function pollUntil(read, accept, message) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = await read();
  while (!accept(last)) {
    if (Date.now() > deadline) throw new Error(`${message}; last read ${JSON.stringify(last)}`);
    await sleep(POLL_INTERVAL_MS);
    last = await read();
  }
  return last;
}

/** Each page's canonical alpha and beta, read through `window.storage` (the Yjs doc, not what the page renders). */
const readCards = (pages, ids) => Promise.all(pages.map(async (page) => {
  const items = await boardItems(page);
  return { alpha: itemById(items, ids.alpha), beta: itemById(items, ids.beta) };
}));

const cardsAt = (cards, alpha, beta) => cards.every((onPage) => sameWorldPoint(onPage.alpha, alpha)
  && sameWorldPoint(onPage.beta, beta) && onPage.beta.text === BETA_FINAL_TEXT);

/** True once both pages hold A's alpha and beta geometry and beta carries B's whole text. */
function converged(cards) {
  const [onA] = cards;
  return Boolean(onA.alpha && onA.beta) && cardsAt(cards, worldPoint(onA.alpha), worldPoint(onA.beta));
}

// ---------------------------------------------------------------- step 1

async function addBothStickies({ a, b }) {
  await addSharedSticky(a, 'en', ALPHA_TEXT, ALPHA_ADD_PX);
  await waitForTextOn([a, b], ALPHA_TEXT);
  await addSharedSticky(b, 'th', BETA_TEXT, BETA_ADD_PX);
  await waitForTextOn([a, b], BETA_TEXT);
  const items = await boardItems(a);
  const alpha = itemWithText(items, ALPHA_TEXT);
  const beta = itemWithText(items, BETA_TEXT);
  assert.ok(alpha && beta, "A's board holds both shared stickies");
  return { ids: { alpha: alpha.id, beta: beta.id }, alpha0: worldPoint(alpha), beta0: worldPoint(beta) };
}

// ---------------------------------------------------------------- step 2

/** Where alpha's centre is after `steps` pointer steps, against where A's pointer put it. */
async function sampleAlpha(a, alphaId, start, steps) {
  const centre = await renderedCentre(a, alphaId);
  const expected = pointerAfter(start, steps);
  return { steps, offX: centre.x - expected.x, offY: centre.y - expected.y, atMs: Date.now() };
}

/** A presses alpha's centre and moves it step by step, sampling the rendered card after each step; the button stays down. */
async function dragAlphaSampled(a, alphaId, start) {
  await dragBy(a, start, DRAG_STEP_PX, { steps: 1, hold: true });
  const samples = [await sampleAlpha(a, alphaId, start, 1)];
  for (let steps = 2; steps <= DRAG_STEP_COUNT; steps += 1) {
    await sleep(SAMPLE_INTERVAL_MS);
    const pointer = pointerAfter(start, steps);
    await a.mouse.move(pointer.x, pointer.y);
    samples.push(await sampleAlpha(a, alphaId, start, steps));
  }
  return samples;
}

/** The fastest and mean time between two samples, i.e. between two of A's pointer steps. */
function stepTiming(samples) {
  const gaps = samples.slice(1).map((sample, index) => sample.atMs - samples[index].atMs);
  return { fastestStepMs: Math.min(...gaps), meanStepMs: rounded(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) };
}

// The board moves the caret to the end a moment after the editor focuses (RetroBoard beginFocus); typing earlier
// would land before the existing text.
const caretAtEndOfEditor = () => {
  const field = document.activeElement;
  return field?.matches?.('textarea') && field.selectionStart === field.value.length;
};

/**
 * B drags beta, then opens its editor (a focused card refuses a drag) and types at the end of its text; returns when
 * the typing started and ended (epoch ms).
 */
async function moveAndTypeBeta(b) {
  await dragBy(b, boxCenter(await stickyBox(b, BETA_TEXT)), BETA_DRAG_PX);
  await b.getByText(BETA_TEXT, { exact: true }).dblclick();
  await b.waitForFunction(caretAtEndOfEditor);
  const typedFromMs = Date.now();
  await b.keyboard.type(BETA_TYPING, { delay: BETA_KEY_DELAY_MS });
  const typedToMs = Date.now();
  await b.keyboard.press(LEAVE_EDITOR_KEY);
  return { typedFromMs, typedToMs };
}

/** How B's typing lined up with A's steps (ms after A's first sample); B must start typing before A's last step. */
function typingOverlap(samples, typing) {
  const relative = (ms) => ms - samples[0].atMs;
  const overlap = {
    bTypedFromMs: relative(typing.typedFromMs), bTypedToMs: relative(typing.typedToMs), aLastStepMs: relative(samples.at(-1).atMs),
  };
  assert.ok(overlap.bTypedFromMs < overlap.aLastStepMs, `B only typed after A's last step: ${JSON.stringify(overlap)}`);
  return overlap;
}

function assertNeverSnapped(samples) {
  const off = samples.filter(({ offX, offY }) => !nearPoint({ x: offX, y: offY }, { x: 0, y: 0 }, SNAP_TOLERANCE_PX));
  const detail = off.map(({ steps, offX, offY }) => `step ${steps}: ${rounded(offX)},${rounded(offY)} px`).join('; ');
  assert.equal(off.length, 0,
    `A's alpha left A's pointer by more than ${SNAP_TOLERANCE_PX} px in ${off.length}/${samples.length} samples (${detail})`);
}

/** Step 2; the hold is released in `finally`, and the release time is kept in `run` for the recent-move window. */
async function dragWithPeer({ a, b }, run) {
  await sleep(UNDO_CAPTURE_SETTLE_MS);
  const start = boxCenter(await stickyBox(a, ALPHA_TEXT));
  run.start = start;
  run.releasePoint = pointerAfter(start, DRAG_STEP_COUNT);
  try {
    const [samples, typing] = await Promise.all([dragAlphaSampled(a, run.ids.alpha, start), moveAndTypeBeta(b)]);
    // Still holding: remote text must reach A during its drag.
    await waitForTextOn([a], BETA_FINAL_TEXT);
    assertNeverSnapped(samples);
    const maxOffsetPx = Math.max(...samples.map(({ offX, offY }) => Math.max(Math.abs(offX), Math.abs(offY))));
    return {
      samples: samples.length, maxOffsetPx: rounded(maxOffsetPx), ...stepTiming(samples), ...typingOverlap(samples, typing),
    };
  } finally {
    await a.mouse.up();
    run.releasedAtMs = Date.now();
  }
}

// ---------------------------------------------------------------- steps 3-5

async function convergeAfterDrag({ a, b }, run) {
  const [onA] = await pollUntil(() => readCards([a, b], run.ids), converged, 'A and B did not converge on alpha and beta');
  const moved = { x: onA.alpha.x - run.alpha0.x, y: onA.alpha.y - run.alpha0.y };
  assert.ok(Math.sign(moved.x) === Math.sign(DRAG_STEP_PX.x) && Math.sign(moved.y) === Math.sign(DRAG_STEP_PX.y),
    `alpha moved ${JSON.stringify(moved)}, not in the pointer's direction`);
  const ratioError = Math.abs((moved.x / moved.y) / (DRAG_STEP_PX.x / DRAG_STEP_PX.y) - 1);
  assert.ok(ratioError <= DIRECTION_RATIO_TOLERANCE, `alpha's dx/dy is ${rounded(ratioError * 100)}% off the pointer's`);
  assert.ok(!sameWorldPoint(onA.beta, run.beta0), "B's drag moved beta");
  run.alphaDragged = worldPoint(onA.alpha);
  run.betaMoved = worldPoint(onA.beta);
  return { alpha0: run.alpha0, alphaDragged: run.alphaDragged, beta0: run.beta0, betaMoved: run.betaMoved };
}

/** Fails unless A is still inside the recent-move window that starts at its release. */
function assertInsideRecentMoveWindow(run, what) {
  const sinceReleaseMs = Date.now() - run.releasedAtMs;
  assert.ok(sinceReleaseMs < RECENT_MOVE_WINDOW_MS, `${what} came ${sinceReleaseMs} ms after release, outside the window`);
  return sinceReleaseMs;
}

/** A renders alpha at `expected` (page px); the guards under test only act on A's rendered state. */
async function assertRenderedAlpha(a, alphaId, expected, what) {
  const centre = await renderedCentre(a, alphaId);
  assert.ok(nearPoint(centre, expected, SNAP_TOLERANCE_PX),
    `${what}: A renders alpha at ${rounded(centre.x)},${rounded(centre.y)}, expected ${rounded(expected.x)},${rounded(expected.y)}`);
}

async function holdAfterDrop({ a, b }, run) {
  await sleep(RECENT_MOVE_PROBE_WAIT_MS);
  const cards = await readCards([a, b], run.ids);
  assert.ok(cardsAt(cards, run.alphaDragged, run.betaMoved), `alpha left its dropped position: ${JSON.stringify(cards)}`);
  await assertRenderedAlpha(a, run.ids.alpha, run.releasePoint, 'after the wait');
  return { sinceReleaseMs: assertInsideRecentMoveWindow(run, 'the hold check') };
}

async function undoRedoOnA({ a, b }, run) {
  const undoAfterMs = assertInsideRecentMoveWindow(run, 'undo');
  await a.keyboard.press(UNDO_KEY);
  await pollUntil(() => readCards([a, b], run.ids), (cards) => cardsAt(cards, run.alpha0, run.betaMoved),
    "undo on A did not put alpha back while leaving B's beta");
  await assertRenderedAlpha(a, run.ids.alpha, run.start, 'after undo');
  assertInsideRecentMoveWindow(run, 'the undo check');
  await a.keyboard.press(REDO_KEY);
  await pollUntil(() => readCards([a, b], run.ids), (cards) => cardsAt(cards, run.alphaDragged, run.betaMoved),
    'redo on A did not restore the dragged alpha');
  await assertRenderedAlpha(a, run.ids.alpha, run.releasePoint, 'after redo');
  await shot(a, 'drag-peer-en.png', run.report);
  await shot(b, 'drag-peer-th.png', run.report);
  return { undoAfterMs };
}

await runLiveCheck('board-drag-peer-live-check.mjs', async (context) => {
  const run = { report: context.report };
  await step(context.report, STEP_NAMES.add, async () => {
    Object.assign(run, await addBothStickies(context));
    return { alpha0: run.alpha0, beta0: run.beta0 };
  });
  await step(context.report, STEP_NAMES.drag, () => dragWithPeer(context, run));
  await step(context.report, STEP_NAMES.converge, () => convergeAfterDrag(context, run));
  await step(context.report, STEP_NAMES.hold, () => holdAfterDrop(context, run));
  await step(context.report, STEP_NAMES.undo, () => undoRedoOnA(context, run));
  await errorsStep(context, LIVE_MODE.PLAIN);
});
