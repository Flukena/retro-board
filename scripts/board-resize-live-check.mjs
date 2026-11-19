#!/usr/bin/env node
/**
 * Two-participant live check of the resize handles (INV-6; refactor design §7.3).
 * English A resizes a zone and a sticky through their corner handles: each gesture changes the size the pointer's
 * distance asks for (divided by the zoom) on both pages, the north-west handle moves the origin with the opposite
 * corner fixed, the size stops at the domain minimum and maximum (`src/domain/item-size-limits.js`), a locked zone
 * shows no handles, and A's undo restores the size before the resize on both pages.
 * Run it through the runner, which starts an isolated relay and Vite:
 * node scripts/live-check-all.mjs --only board-resize --out-root <fresh BaseData dir>
 * or directly: node scripts/board-resize-live-check.mjs <base-url> <BaseData output directory>
 */
import assert from 'node:assert/strict';
import { ITEM_MAX_SIDE_PX, ITEM_MIN_SIZE_PX } from '../src/domain/item-size-limits.js';
import {
  LIVE_MODE, UNDO_KEY, VIEWPORT, addSharedSticky, addZone, appLabel, boardItems, boxCenter, dragBy, errorsStep, itemById,
  pollUntil, runLiveCheck, shot, sleep, step, stickyBox, withinPx,
} from './board-live-helpers.mjs';

const ZONE_TITLE = 'Resize zone';
const STICKY_TEXT = 'rs';
const ZONE_DRAG_PX = Object.freeze({ from: { x: 200, y: 200 }, to: { x: 560, y: 420 } });
// Clear of the zone's right edge (560), so the sticky never lands inside the zone.
const STICKY_ADD_PX = Object.freeze({ x: 760, y: 260 });
const ZONE_GROW_PX = Object.freeze({ x: 120, y: 80 });
const STICKY_GROW_PX = Object.freeze({ x: 90, y: 60 });
const NORTH_WEST_MOVE_PX = Object.freeze({ x: 30, y: 20 });
// The pointer ends this far past the minimum or maximum, so a clamp (not the gesture's own distance) sets the size.
const MARGIN_PX = 40;
// The last resize uses the nw handle: after step 5 the sticky is 1200 world px, and its se handle sits under the
// bottom-right zoom controls, where a press cannot reach it.
const UNDO_RESIZE_PX = Object.freeze({ x: 60, y: 40 });
const SIZE_TOLERANCE_WORLD_PX = 1;
const UNDO_TOLERANCE_WORLD_PX = 0.5;
// The bridge's Y.UndoManager captureTimeout (storage-bridge.js) is 500 ms: local edits closer together are one undo
// step. A pause of twice that keeps the unlock, the resize and the undo apart.
const UNDO_SETTLE_MS = 1_000;
const VIEWPORT_EDGE_PX = 4;
const ZOOM_OUT_CLICK_LIMIT = 10;
const EXPECTED_HANDLE_COUNT = 4;
const SELECTED_ZONE_CLASS = 'rb-zone--selected';
const HANDLE_SELECTOR = '[data-selection-corner]';
const ZONE_EDGE_SELECTOR = '.rb-zone__edge[data-edge="left"]';
const ZOOM_OUT_LABEL_KEY = 'zoom.out';
const DETAIL_DECIMALS = 2;

const STEP_NAMES = Object.freeze({
  zone: 'zone resize syncs',
  sticky: 'sticky se handle resizes both axes',
  northWest: 'nw handle moves the origin',
  minimum: 'shrinking stops at the minimum',
  maximum: 'growing stops at the maximum',
  locked: 'a locked zone shows no resize handles',
  undo: 'undo restores the previous size on both',
});

const rounded = (value) => Number(value.toFixed(DETAIL_DECIMALS));
const sizeOf = (item) => ({ w: item.w, h: item.h });
const geometryOf = (item) => ({ x: item.x, y: item.y, w: item.w, h: item.h });
const handleSelector = (corner) => `[data-selection-corner="${corner}"]`;

/** True when `item` is finite on every key of `expected` and within `tolerance` world px of it. */
const matches = (item, expected, tolerance) => Boolean(item)
  && Object.entries(expected).every(([key, value]) => Number.isFinite(item[key]) && withinPx(item[key], value, tolerance));

/** Each page's canonical copy of the item `id`, read through `window.storage` (the Yjs doc). */
const readItemOn = (pages, id) => Promise.all(pages.map(async (page) => itemById(await boardItems(page), id)));

/** Waits until every page holds `expected` for `id`; returns A's copy (the first page's). */
async function waitForGeometry(pages, id, expected, what, tolerance = SIZE_TOLERANCE_WORLD_PX) {
  const [onFirst] = await pollUntil(() => readItemOn(pages, id), (rows) => rows.every((row) => matches(row, expected, tolerance)), what);
  return onFirst;
}

const zoneOf = (page) => page.locator('.rb-zone').filter({ has: page.locator('.rb-zone__label', { hasText: ZONE_TITLE }) });

/** The centre (page px) of the selected item's `corner` handle; the handle is centred on the corner. */
async function handleCentre(page, corner) {
  const box = await page.locator(handleSelector(corner)).boundingBox();
  if (!box) throw new Error(`no ${corner} resize handle is shown`);
  return boxCenter(box);
}

/** Page px per world px, from the distance between the nw and se handles of the selected item `item`. */
async function zoomOf(page, item) {
  const [nw, se] = await Promise.all([handleCentre(page, 'nw'), handleCentre(page, 'se')]);
  return (se.x - nw.x) / item.w;
}

const dragHandle = async (page, corner, by) => dragBy(page, await handleCentre(page, corner), by);

/** The centre of the part of `box` inside the viewport, where a click is certain to land on the item. */
function visibleCentre(box) {
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, VIEWPORT.width);
  const bottom = Math.min(box.y + box.height, VIEWPORT.height);
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

const selectSticky = async (page) => {
  const point = visibleCentre(await stickyBox(page, STICKY_TEXT));
  await page.mouse.click(point.x, point.y);
  await pollUntil(() => page.locator(HANDLE_SELECTOR).count(), (count) => count === EXPECTED_HANDLE_COUNT,
    'selecting the sticky did not show its four handles');
};

const selectZone = (page) => zoneOf(page).locator(ZONE_EDGE_SELECTOR).click();

const zoneIsSelected = (page) => zoneOf(page).evaluate((node, selectedClass) => node.classList.contains(selectedClass), SELECTED_ZONE_CLASS);

/** The grown size a corner drag of `by` page px asks for, at `zoom` page px per world px. */
const grownSize = (before, by, zoom) => ({ w: before.w + by.x / zoom, h: before.h + by.y / zoom });

/** The geometry a nw drag of `by` page px asks for: the origin moves with the pointer, the opposite corner stays. */
const movedOrigin = (before, by, zoom) => {
  const moved = { x: by.x / zoom, y: by.y / zoom };
  return { x: before.x + moved.x, y: before.y + moved.y, w: before.w - moved.x, h: before.h - moved.y };
};

// ---------------------------------------------------------------- step 1: zone

async function resizeZone({ a, b }, run) {
  await addZone(a, ZONE_TITLE, ZONE_DRAG_PX);
  await selectZone(a);
  const zoneBefore = (await boardItems(a)).find((item) => item.type === 'zone');
  assert.ok(zoneBefore, "A's board holds the zone");
  run.zoneId = zoneBefore.id;
  const box = await zoneOf(a).boundingBox();
  run.zoom = box.width / zoneBefore.w;
  await dragHandle(a, 'se', ZONE_GROW_PX);
  const expected = { x: zoneBefore.x, y: zoneBefore.y, ...grownSize(zoneBefore, ZONE_GROW_PX, run.zoom) };
  const after = await waitForGeometry([a, b], run.zoneId, expected, 'the zone did not grow by the se drag on both pages');
  assert.ok(after.w > 0 && after.w <= ITEM_MAX_SIDE_PX.zone, `zone width ${after.w} is outside 0..${ITEM_MAX_SIDE_PX.zone}`);
  assert.ok(after.h > 0 && after.h <= ITEM_MAX_SIDE_PX.zone, `zone height ${after.h} is outside 0..${ITEM_MAX_SIDE_PX.zone}`);
  return { zoom: rounded(run.zoom), before: geometryOf(zoneBefore), after: geometryOf(after) };
}

// ---------------------------------------------------------------- steps 2-3: sticky

async function resizeStickyFromSe({ a, b }, run) {
  await addSharedSticky(a, 'en', STICKY_TEXT, STICKY_ADD_PX);
  await b.getByText(STICKY_TEXT, { exact: true }).waitFor();
  const items = await boardItems(a);
  const sticky = items.find((item) => item.type === 'sticky' && item.text === STICKY_TEXT);
  assert.ok(sticky, "A's board holds the sticky");
  run.stickyId = sticky.id;
  await selectSticky(a);
  await dragHandle(a, 'se', STICKY_GROW_PX);
  const expected = { x: sticky.x, y: sticky.y, ...grownSize(sticky, STICKY_GROW_PX, run.zoom) };
  const after = await waitForGeometry([a, b], run.stickyId, expected, 'the sticky did not grow on both axes by the se drag');
  return { before: geometryOf(sticky), after: geometryOf(after) };
}

async function resizeStickyFromNw({ a, b }, run, report) {
  const [before] = await readItemOn([a], run.stickyId);
  await dragHandle(a, 'nw', NORTH_WEST_MOVE_PX);
  const expected = movedOrigin(before, NORTH_WEST_MOVE_PX, run.zoom);
  const after = await waitForGeometry([a, b], run.stickyId, expected, 'the nw drag did not move the origin and shrink the sticky');
  assert.ok(withinPx(after.x + after.w, before.x + before.w, SIZE_TOLERANCE_WORLD_PX)
    && withinPx(after.y + after.h, before.y + before.h, SIZE_TOLERANCE_WORLD_PX),
  `the bottom-right corner moved from ${before.x + before.w},${before.y + before.h} to ${after.x + after.w},${after.y + after.h}`);
  await shot(a, 'resize-en.png', report);
  await shot(b, 'resize-th.png', report);
  return { before: geometryOf(before), after: geometryOf(after) };
}

// ---------------------------------------------------------------- steps 4-5: limits

/** The pointer distance (page px, negative) from the se handle that ends MARGIN_PX past the sticky minimum on both axes. */
const shrinkPastMinimum = (size, zoom) => ({
  x: -((size.w - ITEM_MIN_SIZE_PX.sticky.w) * zoom + MARGIN_PX),
  y: -((size.h - ITEM_MIN_SIZE_PX.sticky.h) * zoom + MARGIN_PX),
});

/** The pointer distance (page px) from the se handle that ends MARGIN_PX past the sticky maximum on both axes. */
const growPastMaximum = (size, zoom) => ({
  x: (ITEM_MAX_SIDE_PX.sticky - size.w) * zoom + MARGIN_PX,
  y: (ITEM_MAX_SIDE_PX.sticky - size.h) * zoom + MARGIN_PX,
});

async function shrinkToMinimum({ a, b }, run) {
  const [before] = await readItemOn([a], run.stickyId);
  await dragHandle(a, 'se', shrinkPastMinimum(before, run.zoom));
  const expected = { w: ITEM_MIN_SIZE_PX.sticky.w, h: ITEM_MIN_SIZE_PX.sticky.h };
  const after = await waitForGeometry([a, b], run.stickyId, expected, 'the sticky did not stop at the minimum on both pages', 0);
  return { before: sizeOf(before), after: sizeOf(after), minimum: ITEM_MIN_SIZE_PX.sticky };
}

/** Where the se handle's pointer would end for the maximum drag, in page px. */
async function maximumDragEnd(page, item) {
  const [zoom, se] = [await zoomOf(page, item), await handleCentre(page, 'se')];
  const by = growPastMaximum(item, zoom);
  return { zoom, by, end: { x: se.x + by.x, y: se.y + by.y } };
}

const fitsViewport = ({ end }) => end.x <= VIEWPORT.width - VIEWPORT_EDGE_PX && end.y <= VIEWPORT.height - VIEWPORT_EDGE_PX;

/** Clicks the zoom-out control until the maximum drag's end stays inside the viewport; returns the drag and the clicks. */
async function zoomOutToFit(page, item) {
  const zoomOut = page.getByTitle(appLabel('en', ZOOM_OUT_LABEL_KEY), { exact: true });
  let drag = await maximumDragEnd(page, item);
  for (let clicks = 0; clicks < ZOOM_OUT_CLICK_LIMIT; clicks += 1) {
    if (fitsViewport(drag)) return { ...drag, clicks };
    const zoomBefore = drag.zoom;
    await zoomOut.click();
    drag = await pollUntil(() => maximumDragEnd(page, item), (next) => next.zoom !== zoomBefore, 'the zoom-out control did not change the zoom');
  }
  throw new Error(`${ZOOM_OUT_CLICK_LIMIT} zoom-out clicks did not fit the ${ITEM_MAX_SIDE_PX.sticky} px sticky in the viewport`);
}

async function growToMaximum({ a, b }, run) {
  const [before] = await readItemOn([a], run.stickyId);
  const fit = await zoomOutToFit(a, before);
  run.zoom = fit.zoom;
  await dragHandle(a, 'se', fit.by);
  const cap = ITEM_MAX_SIDE_PX.sticky;
  const after = await waitForGeometry([a, b], run.stickyId, { w: cap, h: cap }, 'the sticky did not stop at the maximum on both pages', 0);
  return { zoomOutClicks: fit.clicks, zoom: rounded(fit.zoom), before: sizeOf(before), after: sizeOf(after), maximum: cap };
}

// ---------------------------------------------------------------- step 6: locked zone

/** Sets the zone's `locked` through the public `window.storage` seam, as the zone menu does. */
const setZoneLocked = (page, id, locked) => page.evaluate(async ([zoneId, value]) => {
  await window.storage.updateItem(zoneId, { locked: value });
}, [id, locked]);

async function lockedZoneHasNoHandles({ a }, run) {
  await selectZone(a);
  await pollUntil(() => a.locator(HANDLE_SELECTOR).count(), (count) => count === EXPECTED_HANDLE_COUNT,
    'the unlocked zone did not show its four handles');
  await setZoneLocked(a, run.zoneId, true);
  await pollUntil(() => a.locator(HANDLE_SELECTOR).count(), (count) => count === 0, 'the locked zone still shows resize handles');
  await selectZone(a);
  assert.ok(await zoneIsSelected(a), 'the locked zone is not selected, so the missing handles prove nothing');
  assert.equal(await a.locator(HANDLE_SELECTOR).count(), 0, 'a selected locked zone shows resize handles');
  return { handlesWhileLocked: 0 };
}

// ---------------------------------------------------------------- step 7: undo

async function undoRestoresSize({ a, b }, run) {
  await setZoneLocked(a, run.zoneId, false);
  await sleep(UNDO_SETTLE_MS);
  await selectSticky(a);
  const [before] = await readItemOn([a], run.stickyId);
  await dragHandle(a, 'nw', UNDO_RESIZE_PX);
  const resized = await waitForGeometry([a, b], run.stickyId, movedOrigin(before, UNDO_RESIZE_PX, run.zoom),
    'the last resize did not reach both pages');
  await sleep(UNDO_SETTLE_MS);
  await a.keyboard.press(UNDO_KEY);
  const restored = await waitForGeometry([a, b], run.stickyId, geometryOf(before),
    'undo did not restore the size before the last resize on both pages', UNDO_TOLERANCE_WORLD_PX);
  return { before: geometryOf(before), resized: geometryOf(resized), restored: geometryOf(restored) };
}

await runLiveCheck('board-resize-live-check.mjs', async (context) => {
  const run = {};
  const { report } = context;
  await step(report, STEP_NAMES.zone, () => resizeZone(context, run));
  await step(report, STEP_NAMES.sticky, () => resizeStickyFromSe(context, run));
  await step(report, STEP_NAMES.northWest, () => resizeStickyFromNw(context, run, report));
  await step(report, STEP_NAMES.minimum, () => shrinkToMinimum(context, run));
  await step(report, STEP_NAMES.maximum, () => growToMaximum(context, run));
  await step(report, STEP_NAMES.locked, () => lockedZoneHasNoHandles(context, run));
  await step(report, STEP_NAMES.undo, () => undoRestoresSize(context, run));
  await errorsStep(context, LIVE_MODE.PLAIN);
});
