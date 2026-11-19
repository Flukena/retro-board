#!/usr/bin/env node
/**
 * Two-participant live check of a drag while a peer edits (INV-5, INV-7, INV-2; refactor design §7.3).
 * English A drags one shared sticky while Thai B, who has just moved another, types into it. A's rendered card follows
 * A's pointer through every remote snapshot (checked after each step and on every animation frame), B's text still
 * reaches A mid-drag, both pages converge, A's card is not snapped back inside the recent-move window, and A's
 * undo/redo reverts only A's drag on both pages.
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
// Each keystroke is a remote snapshot on A. 72 characters (the plan's 30, lengthened per its red-run rule) last about
// A's first 18 of 40 steps, so B is done well before A's last step; contains neither card's text.
const BETA_TYPING = ' was moved, then typed into by B while A was still dragging its own card';
const BETA_FINAL_TEXT = `${BETA_TEXT}${BETA_TYPING}`;
const BETA_KEY_DELAY_MS = 20;
const ALPHA_ADD_PX = Object.freeze({ x: 480, y: 360 });
const BETA_ADD_PX = Object.freeze({ x: 960, y: 360 });
const BETA_DRAG_PX = Object.freeze({ x: 100, y: 0 });
// 12 px across per pointer step (plan) and half that down, so the direction check has two non-zero axes and alpha
// ends below beta, inside the 1440x900 viewport.
const DRAG_STEP_PX = Object.freeze({ x: 12, y: 6 });
const DRAG_DIRECTION = Object.freeze({ x: Math.sign(DRAG_STEP_PX.x), y: Math.sign(DRAG_STEP_PX.y) });
const DRAG_STEP_COUNT = 40;
// The plan's 25 ms wait put A's steps 60-80 ms apart, where every move flushes its geometry at once (DRAG_FLUSH_MS
// 60, DRAG_TRAILING_MS 80 in RetroBoard.jsx) and no snapshot can meet a lagging doc (fix-round measurement: 1 of 72).
// At about 80-140 ms per step the trailing flush lands first, so nearly every move leaves the doc behind A's screen.
const SAMPLE_INTERVAL_MS = 55;
const SNAP_TOLERANCE_PX = 4;
const CONVERGE_TOLERANCE_WORLD_PX = 0.5;
const DIRECTION_RATIO_TOLERANCE = 0.02;
const RECENT_MOVE_PROBE_WAIT_MS = 1_500;
// RetroBoard.jsx RECENT_MOVE_WINDOW_MS: a just-dropped card keeps its local geometry against stale peer echoes.
const RECENT_MOVE_WINDOW_MS = 8_000;
// The bridge's Y.UndoManager captureTimeout (storage-bridge.js): local writes closer together form one undo step.
const UNDO_CAPTURE_TIMEOUT_MS = 500;
// Twice the capture timeout, so A's drag is its own undo step instead of merging into alpha's creation.
const UNDO_CAPTURE_SETTLE_MS = 2 * UNDO_CAPTURE_TIMEOUT_MS;
// Remote snapshots that reach A while its doc lags what it renders; each one would snap a broken build's card back.
const MIN_EXPOSED_SNAPSHOTS = 10;
const POLL_INTERVAL_MS = 100;
const DETAIL_DECIMALS = 1;
const LEAVE_EDITOR_KEY = 'Escape';
const RECORDER_KEY = '__boardDragPeerRecorder';
const HARNESS_TIMING = 'harness timing, not an app failure';

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

// ---------------------------------------------------------------- step 2: B

// The board moves the caret to the end a moment after the editor focuses (RetroBoard beginFocus); typing earlier
// would land before the existing text.
const caretAtEndOfEditor = () => {
  const field = document.activeElement;
  return field?.matches?.('textarea') && field.selectionStart === field.value.length;
};

/** B drags beta, then opens its editor (a focused card refuses a drag) with the caret after its text. */
async function moveBetaAndOpenEditor(b) {
  await dragBy(b, boxCenter(await stickyBox(b, BETA_TEXT)), BETA_DRAG_PX);
  await b.getByText(BETA_TEXT, { exact: true }).dblclick();
  await b.waitForFunction(caretAtEndOfEditor);
}

/** B types into its open editor and leaves it; returns when the typing started and ended (epoch ms). */
async function typeIntoBeta(b) {
  const typedFromMs = Date.now();
  await b.keyboard.type(BETA_TYPING, { delay: BETA_KEY_DELAY_MS });
  const typedToMs = Date.now();
  await b.keyboard.press(LEAVE_EDITOR_KEY);
  return { typedFromMs, typedToMs };
}

// ---------------------------------------------------------------- step 2: A

/**
 * In the page: records alpha's rendered centre on every animation frame, and counts the remote board snapshots that
 * arrive while the doc's alpha differs from the one A renders (`style.left/top`, world px), which is when a build
 * without the drag guard would snap the card back. `window[key].stop()` ends it and returns the record.
 */
function installDragRecorder({ key, selector, alphaId, tolerance }) {
  const record = { frames: [], snapshots: 0, exposed: 0 };
  let stopped = false;
  const differs = (world, cssPx) => Math.abs(world - Number.parseFloat(cssPx)) > tolerance;
  const onChange = (event) => {
    const { key: changed, value } = event.detail || {};
    if (changed !== 'boardState') return;
    record.snapshots += 1;
    const remote = value?.items?.find((item) => item.id === alphaId);
    const shown = document.querySelector(selector)?.style;
    if (remote && shown && (differs(remote.x, shown.left) || differs(remote.y, shown.top))) record.exposed += 1;
  };
  const tick = () => {
    if (stopped) return;
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    if (rect) record.frames.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    requestAnimationFrame(tick);
  };
  window.storage.on(onChange);
  requestAnimationFrame(tick);
  window[key] = {
    stop() {
      stopped = true;
      window.storage.off(onChange);
      return record;
    },
  };
}

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

function assertNeverSnapped(samples) {
  const off = samples.filter(({ offX, offY }) => !nearPoint({ x: offX, y: offY }, { x: 0, y: 0 }, SNAP_TOLERANCE_PX));
  const detail = off.map(({ steps, offX, offY }) => `step ${steps}: ${rounded(offX)},${rounded(offY)} px`).join('; ');
  assert.equal(off.length, 0,
    `A's alpha left A's pointer by more than ${SNAP_TOLERANCE_PX} px in ${off.length}/${samples.length} samples (${detail})`);
}

/** Frames where alpha fell back against the pointer's direction by more than SNAP_TOLERANCE_PX from its furthest point. */
function backtrackedFrames(frames, start) {
  const furthest = { x: -Infinity, y: -Infinity };
  return frames.flatMap((frame, index) => {
    const progress = { x: DRAG_DIRECTION.x * (frame.x - start.x), y: DRAG_DIRECTION.y * (frame.y - start.y) };
    furthest.x = Math.max(furthest.x, progress.x);
    furthest.y = Math.max(furthest.y, progress.y);
    const backPx = Math.max(furthest.x - progress.x, furthest.y - progress.y);
    return backPx > SNAP_TOLERANCE_PX ? [{ frame: index, backPx: rounded(backPx) }] : [];
  });
}

/** Frames where alpha sat anywhere but at one of the pointer's step positions. */
function offPathFrames(frames, start) {
  return frames.flatMap((frame, index) => {
    const steps = Math.min(DRAG_STEP_COUNT, Math.max(0, Math.round((frame.x - start.x) / DRAG_STEP_PX.x)));
    if (nearPoint(frame, pointerAfter(start, steps), SNAP_TOLERANCE_PX)) return [];
    return [{ frame: index, x: rounded(frame.x), y: rounded(frame.y) }];
  });
}

/** Every recorded frame: alpha never falls back against the pointer, stays on its path and ends where it ended. */
function assertFramesFollowPointer(frames, start) {
  const back = backtrackedFrames(frames, start);
  assert.equal(back.length, 0, `A's alpha moved back against the pointer by more than ${SNAP_TOLERANCE_PX} px in `
    + `${back.length}/${frames.length} frames: ${JSON.stringify(back)}`);
  const off = offPathFrames(frames, start);
  assert.equal(off.length, 0, `A's alpha left the pointer's path in ${off.length}/${frames.length} frames: ${JSON.stringify(off)}`);
  assert.ok(frames.length && nearPoint(frames.at(-1), pointerAfter(start, DRAG_STEP_COUNT), SNAP_TOLERANCE_PX),
    "A's alpha did not end at the pointer's last position");
}

/** The run exercised the guard: frames were recorded, enough snapshots met a lagging doc, B finished before A did. */
function assertHarnessTiming(record, timeline) {
  const context = JSON.stringify(timeline);
  assert.ok(record.frames.length >= DRAG_STEP_COUNT, `${HARNESS_TIMING}: the recorder saw only ${record.frames.length} frames`);
  assert.ok(record.exposed >= MIN_EXPOSED_SNAPSHOTS, `${HARNESS_TIMING}: only ${record.exposed} of ${record.snapshots} `
    + `remote snapshots reached A while its doc lagged its screen (need ${MIN_EXPOSED_SNAPSHOTS}); ${context}`);
  assert.ok(timeline.bTypedToMs < timeline.aLastStepMs, `${HARNESS_TIMING}: B was still typing at A's last step; ${context}`);
}

/** The fastest and mean time between two of A's steps, and B's typing, in ms after A's first step. */
function dragTimeline(samples, typed) {
  const gaps = samples.slice(1).map((sample, index) => sample.atMs - samples[index].atMs);
  const relative = (ms) => ms - samples[0].atMs;
  return {
    fastestStepMs: Math.min(...gaps), slowestStepMs: Math.max(...gaps),
    meanStepMs: rounded(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length),
    bTypedFromMs: relative(typed.typedFromMs), bTypedToMs: relative(typed.typedToMs), aLastStepMs: relative(samples.at(-1).atMs),
  };
}

/** Step 2; the hold is released in `finally`, and the release time is kept in `run` for the undo and recent-move windows. */
async function dragWithPeer({ a, b }, run) {
  // B moves beta and opens its editor while A pauses past the undo capture window.
  await Promise.all([sleep(UNDO_CAPTURE_SETTLE_MS), moveBetaAndOpenEditor(b)]);
  const start = boxCenter(await stickyBox(a, ALPHA_TEXT));
  run.start = start;
  run.releasePoint = pointerAfter(start, DRAG_STEP_COUNT);
  await a.evaluate(installDragRecorder, {
    key: RECORDER_KEY, selector: stickySelector(run.ids.alpha), alphaId: run.ids.alpha, tolerance: CONVERGE_TOLERANCE_WORLD_PX,
  });
  try {
    // B's typing is started first, so it overlaps A's steps from the first one.
    const [typed, samples] = await Promise.all([typeIntoBeta(b), dragAlphaSampled(a, run.ids.alpha, start)]);
    run.lastStepAtMs = samples.at(-1).atMs;
    // Still holding: remote text must reach A during its drag.
    await waitForTextOn([a], BETA_FINAL_TEXT);
    const record = await a.evaluate((key) => window[key].stop(), RECORDER_KEY);
    const timeline = dragTimeline(samples, typed);
    assertNeverSnapped(samples);
    assertFramesFollowPointer(record.frames, start);
    assertHarnessTiming(record, timeline);
    const maxOffsetPx = Math.max(...samples.map(({ offX, offY }) => Math.max(Math.abs(offX), Math.abs(offY))));
    return {
      samples: samples.length, maxOffsetPx: rounded(maxOffsetPx), frames: record.frames.length,
      snapshots: record.snapshots, exposedSnapshots: record.exposed, ...timeline,
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
  assert.ok(Math.sign(moved.x) === DRAG_DIRECTION.x && Math.sign(moved.y) === DRAG_DIRECTION.y,
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

/**
 * Fails unless A released within the undo capture window of its last step. The release writes alpha's final position
 * again; later than that, the write is an undo step of its own and one undo would only revert it.
 */
function assertReleasedInsideUndoCapture(run) {
  const releaseAfterLastStepMs = run.releasedAtMs - run.lastStepAtMs;
  assert.ok(releaseAfterLastStepMs < UNDO_CAPTURE_TIMEOUT_MS, `${HARNESS_TIMING}: A released ${releaseAfterLastStepMs} ms `
    + `after its last step, past the ${UNDO_CAPTURE_TIMEOUT_MS} ms undo capture`);
  return releaseAfterLastStepMs;
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
  const releaseAfterLastStepMs = assertReleasedInsideUndoCapture(run);
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
  return { releaseAfterLastStepMs, undoAfterMs };
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
