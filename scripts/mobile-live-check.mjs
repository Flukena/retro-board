#!/usr/bin/env node
// Usage: node scripts/mobile-live-check.mjs <base-url> <BaseData output> [chromium|webkit] [all|private|public|preview]
// Creates private-room fixtures and removes only its own public test cards.
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js/index-native.js';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PALETTE, paletteIndexByName } from '../src/client/ui/palette.js';
import { t, setLang } from '../src/client/ui/i18n.js';
import { SELECTION_TOOLBAR_GAP_PX, TOOLBAR_MIN_ANCHOR_PX } from '../src/client/chrome/chrome-layout.js';
import { Z } from '../src/client/chrome/chrome-layout.js';
import { parseColor } from '../src/client/ui/color-contrast.js';
import { VIEWPORT_ZOOM_MAX } from '../src/domain/viewport-limits.js';
import { PUBLIC_RELAY_PREFIX, PUBLIC_SNAPSHOT_ROUTE } from '../src/domain/public-wall-contract.js';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const PLAYWRIGHT_MODULE = '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const ACTION_TIMEOUT_MS = 15_000;
const FRAME_INTERVAL_MS = 20;
const NATIVE_SELECTION_CLICK_COUNT = 3;
const NATIVE_PINCH_FACTOR = 1.5;
const NATIVE_PAN_DELTA_PX = 24;
const NATIVE_ANCHOR_FRACTION = 0.6;
const NATIVE_ANCHOR_TOLERANCE_WORLD_PX = 0.05;
const LAYOUT_SETTLE_MS = 350;
const RETRY_INTERVAL_MS = 250;
const GESTURE_STEPS = 8;
const EDGE_TOLERANCE_PX = 2;
const SELECTION_FOLLOW_FRAME_COUNT = 32;
const SELECTION_FOLLOW_TOLERANCE_PX = 1;
const SELECTION_PAN_DELTA_PX = 4;
const SELECTION_ZOOM_DELTA_Y = 1.5;
const NATIVE_SCROLL_PROBE_OFFSET_PX = 100;
const NATIVE_SCROLL_PROBE_DELTA_PX = 30;
const PRESENCE_ZOOM_LEVELS = [0.25, 0.5, 1, 2];
const PRESENCE_RADIUS_TOLERANCE_PX = 0.01;
const PRESENCE_ZOOM_TOLERANCE = 0.001;
const PRESENCE_BORDER_SCREEN_PX = 2;
const PINCH_WHEEL_SENSITIVITY = 0.01;
const TOUCH_MOVE_PX = 36;
const TOUCH_TARGET_MIN_PX = 44;
const INLINE_SCROLL_LINE_COUNT = 24;
const TEXT_HIGH_ZOOM_CLICK_COUNT = 2;
const IMAGE_FIXTURE_WIDTH_PX = 128;
const IMAGE_FIXTURE_HEIGHT_PX = 96;
const IMAGE_FIXTURE_COLORS = [[230, 30, 190], [20, 210, 235]];
const IMAGE_FIXTURE_MIME = 'image/png';
const UPLOAD_SUCCESS_STATUS = 200;
const PNG_SIGNATURE_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];
const INLINE_SCROLL_TOUCH_INSET_PX = 4;
const INPUT_START_SHORTCUT = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';
const INPUT_END_SHORTCUT = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
const MOBILE_INPUT_MIN_FONT_PX = 16;
const DRAWING_RED = '#dc2626';
const DRAWING_MIN_INK_PIXELS = 20;
const DRAWING_STROKE_WIDTH_PX = 8;
const ORDINARY_IMAGE_MAX_WORLD_PX = 480;
const PREVIEW_IMAGE_WIDTH_PX = 1200;
const PREVIEW_IMAGE_HEIGHT_PX = 720;
const PREVIEW_RGB_TOLERANCE = 8;
const PREVIEW_MIN_MATCHED_PIXELS = 16;
const PREVIEW_COLOR_NAMES = ['red', 'green'];
const OFFLINE_SOCKET_CLOSE_CODE = 1001;
const OFFLINE_SOCKET_CLOSE_REASON = 'Mobile regression network interruption';
const RETRO_LOOP_ZONE_COUNT = 6;
const KEYBOARD_VIEWPORT_HEIGHT_PX = 340;
const KEYBOARD_VIEWPORT_TOP_PX = 24;
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const NARROW_MOBILE_VIEWPORT = { width: 360, height: 800 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const LAYOUT_VIEWPORTS = [
  NARROW_MOBILE_VIEWPORT, MOBILE_VIEWPORT, { width: 430, height: 932 },
  { width: 844, height: 390 }, { width: 768, height: 1024 },
];
const WORDS = {
  en: { zoomIn: 'Zoom in', create: 'Create', name: 'e.g. "Fluke"', enter: 'Enter room', done: 'Done', edit: 'Edit text', close: 'Close', fit: 'Fit to content',
    undo: 'Undo (Ctrl+Z)', redo: 'Redo (Ctrl+Shift+Z)',
    privacy: 'Off: hide in the normal UI (not encrypted)', sticky: 'Double-click to edit', remove: 'Delete' },
  th: { zoomIn: 'ซูมเข้า', create: 'Create', name: 'เช่น "ฟลุค"', enter: 'เข้าห้อง', done: 'เสร็จสิ้น', edit: 'แก้ไขข้อความ', close: 'ปิด', fit: 'พอดีกับเนื้อหา',
    undo: 'ย้อนกลับ (Ctrl+Z)', redo: 'ทำซ้ำ (Ctrl+Shift+Z)',
    privacy: 'ปิด: ซ่อนในหน้าจอปกติ (ไม่ได้เข้ารหัส)', sticky: 'ดับเบิลคลิกเพื่อแก้ไข', remove: 'ลบ' },
};
const [baseArgument, outputArgument, engine = 'chromium', roomMode = 'all'] = process.argv.slice(2);
assert.ok(baseArgument && outputArgument, 'Pass base URL and external output directory');
const baseUrl = new URL(baseArgument).origin;
const output = resolve(outputArgument);
assert.ok(output.startsWith(`${SSD_ROOT}/`), 'Output must use the operator SSD volume');
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev, 'SSD must be mounted');
await mkdir(join(output, 'browser-temp'), { recursive: true });
process.env.TMPDIR = join(output, 'browser-temp');
const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || PLAYWRIGHT_MODULE).href);
assert.ok(['chromium', 'webkit'].includes(engine), 'Engine must be chromium or webkit');
assert.ok(['all', 'private', 'public', 'preview', 'drawing', 'realtime'].includes(roomMode), 'Unknown room mode');
const browser = await playwright[engine].launch({ headless: true });
const report = { engine, roomMode, pageErrors: [], steps: [], measurements: [], fixtureIds: [], pages: [] };

async function step(name, action) {
  await action();
  report.steps.push(name);
  console.log(`PASS ${name}`);
}
async function participant(mobile, lang) {
  const context = await browser.newContext({ viewport: mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
    isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(langValue => localStorage.setItem('rb_lang', langValue), lang);
  const network = mobile ? await controlSocketNetwork(context) : null;
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const navigation = { mobile, lang, mainNavigations: 0, viteRefreshes: 0 };
  report.pages.push(navigation);
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigation.mainNavigations++; });
  page.on('console', message => { if (/^\[vite\].*(hmr update|page reload)/.test(message.text())) navigation.viteRefreshes++; });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  return { context, page, mobile, lang, network };
}
async function controlSocketNetwork(context) {
  const network = { offline: false, pairs: new Set() };
  await context.routeWebSocket(url => url.searchParams.has('awarenessId'), async client => {
    if (network.offline) {
      await client.close({ code: OFFLINE_SOCKET_CLOSE_CODE, reason: OFFLINE_SOCKET_CLOSE_REASON });
      return;
    }
    const server = client.connectToServer();
    const pair = { client, server };
    network.pairs.add(pair);
    client.onClose(async (code, reason) => {
      network.pairs.delete(pair);
      await server.close({ code, reason });
    });
    server.onClose(async (code, reason) => {
      network.pairs.delete(pair);
      await client.close({ code, reason });
    });
  });
  return network;
}
async function setMobileOffline(user, offline) {
  const pairs = [...user.network.pairs];
  if (offline) assert.ok(pairs.length > 0, 'Reconnect fixture must start with a live relay transport');
  user.network.offline = offline;
  await user.context.setOffline(offline);
  if (offline) {
    const routes = pairs.flatMap(pair => [pair.client, pair.server]);
    await Promise.all(routes.map(route => route.close({ code: OFFLINE_SOCKET_CLOSE_CODE, reason: OFFLINE_SOCKET_CLOSE_REASON })));
    user.network.pairs.clear();
  }
}
async function activate(user, locator) {
  if (user.mobile) await locator.tap();
  else await locator.click();
}
async function closeTemplates(user) {
  const close = user.page.locator('.rb-template-popover').getByRole('button', { name: WORDS[user.lang].close, exact: true });
  if (await close.isVisible()) await activate(user, close);
  else if (await user.page.locator('.rb-template-backdrop').isVisible()) {
    await user.page.locator('.rb-template-backdrop').click({ position: { x: 1, y: 1 } });
  }
}
async function enter(user, url) {
  await user.page.goto(url, { waitUntil: 'domcontentloaded' });
  const name = user.page.getByPlaceholder(WORDS[user.lang].name, { exact: true });
  await name.fill(`Mobile check ${user.lang}`);
  await activate(user, user.page.getByRole('button', { name: WORDS[user.lang].enter, exact: true }));
  await user.page.locator('.rb-no-select').waitFor();
  await closeTemplates(user);
}


async function nativePinch(user, selector) {
  const before=await viewport(user);
  const anchor=await user.page.locator(selector).evaluate((node,fraction)=>{
    const rect=node.getBoundingClientRect();return{x:rect.left+rect.width*fraction,y:rect.top+rect.height*fraction};
  },NATIVE_ANCHOR_FRACTION);
  await user.page.locator(selector).evaluate((node,{factor,point})=>{
    for(const[type,scale]of[['gesturestart',1],['gesturechange',factor],['gestureend',factor]]){
      const event=new Event(type,{bubbles:true,cancelable:true});Object.assign(event,{scale,clientX:point.x,clientY:point.y});node.dispatchEvent(event);
    }
  },{factor:NATIVE_PINCH_FACTOR,point:anchor});
  const expected=Math.min(VIEWPORT_ZOOM_MAX,before.zoom*NATIVE_PINCH_FACTOR);
  await eventually(async()=>Math.abs((await viewport(user)).zoom-expected)<PRESENCE_ZOOM_TOLERANCE,'Native Safari gesture scale reaches the board viewport');
  const after=await viewport(user);
  for(const axis of ['x','y'])assert.ok(Math.abs((anchor[axis]-after[axis])/after.zoom-(anchor[axis]-before[axis])/before.zoom)<NATIVE_ANCHOR_TOLERANCE_WORLD_PX,'Native pinch keeps its world anchor');
}
async function toggleWheelZoom(user) {
  await activate(user,user.page.getByTitle(drawingWord(user,'topbar.more'),{exact:true}));
  await activate(user,user.page.locator('.rb-topbar-popover--more').getByRole('button',{name:drawingWord(user,'settings.scrollWheelZoom'),exact:true}));
  await user.page.locator('.rb-topbar-backdrop').click({position:{x:1,y:1}});
}
async function checkDesktopNativeGestures(user) {
  const before=await viewport(user);
  await user.page.locator('.rb-no-select').evaluate((node,{delta,fraction})=>{
    const bounds=node.getBoundingClientRect();
    node.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:delta,deltaY:delta,
      clientX:bounds.left+bounds.width*fraction,clientY:bounds.top+bounds.height*fraction}));
  },{delta:NATIVE_PAN_DELTA_PX,fraction:NATIVE_ANCHOR_FRACTION});
  await eventually(async()=>Math.abs((await viewport(user)).x-(before.x-NATIVE_PAN_DELTA_PX))<NATIVE_ANCHOR_TOLERANCE_WORLD_PX,'Two-finger trackpad wheel pan still works');
  assert.equal((await viewport(user)).zoom,before.zoom);
  await nativePinch(user,'.rb-no-select');
  await toggleWheelZoom(user);
  try {await nativePinch(user,'.rb-no-select');}finally{await toggleWheelZoom(user);}
  await openDrawing(user);await nativePinch(user,'.rb-drawing-canvas');
  await activate(user,drawingToolbar(user).getByRole('button',{name:drawingWord(user,'draw.cancel'),exact:true}));
  await drawingToolbar(user).waitFor({state:'hidden'});await activate(user,user.page.locator('.rb-zoom-percentage'));
}

async function checkNativeSelectionRange(user) {
  const fixtureId = 'native-selection-probe';
  await user.page.evaluate(({ id, zIndex }) => {
    const fixture = document.createElement('div'); fixture.id = id; fixture.textContent = 'Native selection probe';
    Object.assign(fixture.style, { position: 'fixed', top: '50%', left: '25%', width: 'max-content', zIndex: String(zIndex) });
    document.getElementById('root').append(fixture); getSelection().removeAllRanges();
  }, { id: fixtureId, zIndex: Z.MODAL_RAISED });
  const fixture = user.page.locator(`#${fixtureId}`);
  try {
    await fixture.click({ clickCount: NATIVE_SELECTION_CLICK_COUNT });
    assert.equal(await user.page.evaluate(() => getSelection().toString().length), 0, 'Native clicks cannot select page text under the mobile policy');
    await fixture.evaluate(node => { node.style.userSelect = 'text'; node.style.webkitUserSelect = 'text'; });
    await fixture.click({ clickCount: NATIVE_SELECTION_CLICK_COUNT });
    assert.ok(await user.page.evaluate(() => getSelection().toString().length) > 0, 'Explicit native selection is a working positive control');
  } finally {
    await fixture.evaluate(node => { getSelection().removeAllRanges(); node.remove(); });
  }
}

async function checkNativePageSelection(user) {
  const values=await user.page.evaluate(()=>({
    coarse:matchMedia('(pointer:coarse)').matches,
    root:getComputedStyle(document.getElementById('root')).userSelect,
    labels:[...document.querySelectorAll('.rb-landing__title,.rb-topbar,.rb-dock-tile__label')].map(node=>({
      callout:getComputedStyle(node).getPropertyValue('-webkit-touch-callout'),
    })),
    supportsCallout:CSS.supports('-webkit-touch-callout','none'),
  }));
  assert.equal(values.coarse,user.mobile);
  if(!user.mobile){assert.notEqual(values.root,'none','Desktop page text keeps native selection');return;}
  assert.ok(values.labels.length>0);
  assert.equal(values.root,'none','The mobile page boundary disables native selection');
  await checkNativeSelectionRange(user);
  for(const value of values.labels){
    if(values.supportsCallout)assert.equal(value.callout,'none','Mobile page labels suppress the native callout');
  }
  const editors=await user.page.evaluate(()=>{
    const fixture=document.createElement('div');fixture.innerHTML='<input value="alpha beta"><textarea>alpha beta</textarea><div contenteditable="true"><span>alpha beta</span></div><div contenteditable="plaintext-only">alpha beta</div>';
    fixture.style.display='none';document.getElementById('root').append(fixture);
    try{return[...fixture.querySelectorAll('input,textarea,[contenteditable],span')].map(node=>({selection:getComputedStyle(node).userSelect,callout:getComputedStyle(node).getPropertyValue('-webkit-touch-callout')}));}
    finally{fixture.remove();}
  });
  for(const editor of editors){assert.equal(editor.selection,'text','Native editor selection remains enabled');if(values.supportsCallout)assert.equal(editor.callout,'default');}
}

async function checkLanding(mobile) {
  await mobile.page.goto(baseUrl);
  assert.match(await mobile.page.locator('meta[name="viewport"]').getAttribute('content'), /viewport-fit\s*=\s*cover/);
  for (const size of LAYOUT_VIEWPORTS) {
    await mobile.page.setViewportSize(size);
    await mobile.page.waitForTimeout(LAYOUT_SETTLE_MS);
    const layout = await mobile.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      coarse: matchMedia('(pointer: coarse)').matches,
      inputFonts: [...document.querySelectorAll('.rb-landing__input')].map(node => parseFloat(getComputedStyle(node).fontSize)),
    }));
    assert.equal(layout.overflow, false, `Landing must not overflow at ${size.width}px`);
    assert.equal(layout.coarse, true, 'Mobile fixture must exercise coarse-pointer styles');
    assert.ok(layout.inputFonts.length > 0);
    assert.ok(layout.inputFonts.every(font => font >= MOBILE_INPUT_MIN_FONT_PX), 'Landing inputs must avoid focus zoom');
    const create = mobile.page.getByRole('button', { name: WORDS[mobile.lang].create, exact: true });
    assert.equal(await create.isVisible(), true);
    const box = await create.evaluate(node => node.getBoundingClientRect().toJSON());
    assert.ok(box.height >= TOUCH_TARGET_MIN_PX, 'Create target must be touch sized');
    assertWithinViewport(box, size, 'Landing Create');
    report.measurements.push({ mode: 'landing', size, ...layout, createBounds: box });
  }
  await mobile.page.setViewportSize(MOBILE_VIEWPORT);
  await checkNativePageSelection(mobile);
  await mobile.page.screenshot({ path: join(output, 'mobile-landing.png') });
}
async function createPrivateRoom(user) {
  await user.page.goto(baseUrl);
  await activate(user, user.page.getByRole('button', { name: WORDS[user.lang].create, exact: true }));
  await user.page.waitForURL(/\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/);
  const url = user.page.url();
  await user.page.getByPlaceholder(WORDS[user.lang].name, { exact: true }).fill(`Room creator ${user.lang}`);
  await activate(user, user.page.getByRole('button', { name: WORDS[user.lang].enter, exact: true }));
  await user.page.locator('.rb-no-select').waitFor();
  await closeTemplates(user);
  return url;
}
const card = (user, text) => user.page.locator('.rb-sticky').filter({ hasText: text }).first();
async function fit(user) {
  await activate(user, user.page.getByTitle(WORDS[user.lang].fit, { exact: true }));
}
async function locatorBounds(target) {
  if (!(await target.isVisible())) return null;
  return target.evaluate(node => {
    const item = node.closest('.rb-sticky, .rb-card-overview') || node;
    const box = item.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { ...box.toJSON(), centerHit: !!hit && item.contains(hit) };
  });
}
async function targetUsable(user, box) {
  if (!box?.centerHit || box.width < TOUCH_TARGET_MIN_PX || box.height < TOUCH_TARGET_MIN_PX) return false;
  const limits = await user.page.evaluate(() => ({
    width: innerWidth,
    top: document.querySelector('.rb-topbar').getBoundingClientRect().bottom,
    bottom: innerHeight,
    railRight: document.querySelector('.rb-tool-dock').getBoundingClientRect().right,
  }));
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  return centerX > limits.railRight && centerX < limits.width && centerY > limits.top && centerY < limits.bottom;
}
async function frameTarget(user, box) {
  const canvas = await user.page.locator('.rb-no-select').evaluate(node => node.getBoundingClientRect().toJSON());
  const center = { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 };
  await user.page.mouse.move(center.x, center.y);
  await user.page.mouse.down({ button: 'middle' });
  await user.page.mouse.move(center.x + center.x - box.left - box.width / 2,
    center.y + center.y - box.top - box.height / 2, { steps: GESTURE_STEPS });
  await user.page.mouse.up({ button: 'middle' });
  await activate(user, user.page.locator('.rb-zoom-percentage'));
}
async function showLocator(user, target) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await targetUsable(user, await locatorBounds(target))) return;
    await fit(user);
    const box = await locatorBounds(target);
    if (box) await frameTarget(user, box);
    if (await targetUsable(user, await locatorBounds(target))) return;
    await user.page.waitForTimeout(RETRY_INTERVAL_MS);
  }
  assert.fail('Fixture must have a touch-sized target inside the usable viewport');
}
async function showText(user, text) {
  await showLocator(user, user.page.getByText(text, { exact: true }));
}
async function addMobileCard(user, text, privateRoom) {
  await user.page.locator('[data-tool="sticky"]').tap();
  await user.page.locator('.rb-mobile-editor__input').fill(text);
  await user.page.getByRole('button', { name: WORDS[user.lang].done, exact: true }).tap();
  await user.page.locator('.rb-mobile-editor__input').waitFor({ state: 'hidden' });
  if (privateRoom) await user.page.getByTitle(WORDS[user.lang].privacy, { exact: true }).tap();
}
async function addDesktopCard(user, text, privateRoom) {
  const position = await user.page.locator('.rb-no-select').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    const STEP_PX = 80;
    const TOP_INSET_PX = 120;
    const BOTTOM_INSET_PX = 200;
    for (let y = TOP_INSET_PX; y < rect.height - BOTTOM_INSET_PX; y += STEP_PX) {
      for (let x = STEP_PX; x < rect.width - STEP_PX; x += STEP_PX) {
        if (document.elementFromPoint(rect.left + x, rect.top + y) === canvas) return { x, y };
      }
    }
    throw new Error('No blank fixture position');
  });
  await user.page.locator('.rb-no-select').dblclick({ position });
  const input = user.page.getByPlaceholder(WORDS.en.sticky, { exact: true });
  await input.fill(text);
  await input.press('Escape');
  if (privateRoom) await user.page.getByTitle(WORDS.en.privacy, { exact: true }).click();
}
async function viewport(user) {
  return user.page.locator('.rb-no-select > div').first().evaluate(node => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}
async function elementGeometry(target) {
  return target.evaluate(node => ({ x: parseFloat(node.style.left), y: parseFloat(node.style.top),
    w: parseFloat(node.style.width), h: parseFloat(node.style.height) }));
}
async function geometry(user, text) {
  return elementGeometry(card(user, text));
}
async function touches(user) {
  if (engine === 'chromium') {
    const session = await user.context.newCDPSession(user.page);
    return (type, points) => session.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(point => ({ ...point, radiusX: 1, radiusY: 1 })) });
  }
  return (type, points) => user.page.evaluate(({ type: eventType, points: next }) => {
    const previous = window.__rbPointerCheckPoints || [];
    const name = { touchStart: 'pointerdown', touchMove: 'pointermove', touchEnd: 'pointerup' }[eventType];
    const active = eventType === 'touchEnd' ? previous : next;
    for (const point of active) {
      if (eventType === 'touchStart' && previous.some(entry => entry.id === point.id)) continue;
      const target = document.elementFromPoint(point.x, point.y) || document.body;
      target.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true,
        pointerType: 'touch', pointerId: point.id, clientX: point.x, clientY: point.y, buttons: eventType === 'touchEnd' ? 0 : 1 }));
    }
    window.__rbPointerCheckPoints = eventType === 'touchEnd' ? [] : next;
  }, { type, points });
}
async function drag(user, start, delta) {
  const send = await touches(user);
  await send('touchStart', [{ id: 1, ...start }]);
  for (let index = 1; index <= GESTURE_STEPS; index++) {
    await send('touchMove', [{ id: 1, x: start.x + delta.x * index / GESTURE_STEPS, y: start.y + delta.y * index / GESTURE_STEPS }]);
    await user.page.waitForTimeout(FRAME_INTERVAL_MS);
  }
  await send('touchEnd', []);
}
async function checkDrag(mobile, desktop, text) {
  await showText(mobile, text);
  const before = await geometry(mobile, text);
  const zoom = (await viewport(mobile)).zoom;
  const box = await card(mobile, text).boundingBox();
  await drag(mobile, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: TOUCH_MOVE_PX, y: -TOUCH_MOVE_PX });
  await mobile.page.waitForTimeout(LAYOUT_SETTLE_MS);
  const after = await geometry(mobile, text);
  assert.ok(Math.abs(after.x - before.x - TOUCH_MOVE_PX / zoom) < EDGE_TOLERANCE_PX);
  await showText(desktop, text);
  const remote = await geometry(desktop, text);
  assert.ok(Math.abs(remote.x - after.x) < EDGE_TOLERANCE_PX);
}
async function checkResize(mobile, desktop, text) {
  const before = await geometry(mobile, text);
  const handle = mobile.page.locator('[data-mobile-resize="true"]').last();
  const box = await handle.boundingBox();
  assert.ok(box.width >= TOUCH_TARGET_MIN_PX && box.height >= TOUCH_TARGET_MIN_PX, 'Resize targets must be touch sized');
  await drag(mobile, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: TOUCH_MOVE_PX, y: TOUCH_MOVE_PX });
  await mobile.page.waitForTimeout(LAYOUT_SETTLE_MS);
  assert.ok((await geometry(mobile, text)).w > before.w);
  await showText(desktop, text);
  assert.ok((await geometry(desktop, text)).w > before.w);
  const resized = await geometry(mobile, text);
  await historyAction(mobile, 'undo');
  await assertSharedGeometry(mobile, desktop, text, before);
  await historyAction(mobile, 'redo');
  await assertSharedGeometry(mobile, desktop, text, resized);
}
async function eventually(check, message = 'Shared state did not converge before timeout') {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (!(await check()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
  assert.ok(await check(), message);
}
async function historyAction(user, action) {
  await activate(user, user.page.getByTitle(WORDS[user.lang][action], { exact: true }));
}
async function assertElementGeometry(target, expected) {
  await eventually(async () => {
    const actual = await elementGeometry(target);
    return Object.keys(expected).every(key => Math.abs(actual[key] - expected[key]) < EDGE_TOLERANCE_PX);
  });
}
async function assertSharedGeometry(mobile, desktop, text, expected) {
  for (const user of [mobile, desktop]) await assertElementGeometry(card(user, text), expected);
}
function assertWithinViewport(box, size, label) {
  assert.ok(box.left >= -EDGE_TOLERANCE_PX && box.right <= size.width + EDGE_TOLERANCE_PX, `${label} must fit width`);
  assert.ok(box.top >= -EDGE_TOLERANCE_PX && box.bottom <= size.height + EDGE_TOLERANCE_PX, `${label} must fit height`);
}
async function zoneSnapshot(user) {
  await fit(user);
  return user.page.locator('.rb-zone').evaluateAll(nodes => nodes.map(node => ({
    title: node.querySelector('.rb-zone__label')?.textContent,
    x: node.style.left, y: node.style.top, width: node.style.width, height: node.style.height,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}
async function previewSnapshotState(response, requireRetroColors, imageFixture) {
  if (new URL(response.url()).pathname !== `${PUBLIC_RELAY_PREFIX}${PUBLIC_SNAPSHOT_ROUTE}` || !response.ok()) return null;
  const snapshot = await response.json();
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  if (imageFixture && !items.some(item => item.id === imageFixture.id && item.src === imageFixture.src)) return null;
  const colors = [...new Set(items.filter(item => item.type === 'zone').map(item => (
    Number.isSafeInteger(item.color) && PALETTE[item.color] ? item.color : paletteIndexByName('yellow')
  )))];
  const retroColors = PREVIEW_COLOR_NAMES.map(paletteIndexByName);
  if (requireRetroColors && !retroColors.every(color => colors.includes(color))) return null;
  return { colors: requireRetroColors ? retroColors : colors, itemCount: items.length };
}
async function decodedImagePixels(target, colors) {
  const source = await target.getAttribute('src');
  const crossOrigin = new URL(source, baseUrl).origin !== baseUrl && !source.startsWith('blob:');
  let base64 = null;
  if (crossOrigin) {
    const response = await target.page().request.get(source);
    assert.ok(response.ok(), 'Authenticated image bytes must be readable');
    base64 = (await response.body()).toString('base64');
  }
  return target.evaluate(async (image, options) => {
    if (!image.complete || !image.naturalWidth) return null;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (options.base64) {
      const bytes = Uint8Array.from(atob(options.base64), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes]));
      try { context.drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
    } else context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = options.colors.map(() => 0);
    let variedPixels = 0;
    let opaquePixels = 0;
    const ALPHA_CHANNEL_INDEX = 3;
    const CHANNEL_COUNT = 4;
    const RGB_CHANNEL_COUNT = 3;
    for (let offset = 0; offset < pixels.length; offset += CHANNEL_COUNT) {
      if (pixels[offset + ALPHA_CHANNEL_INDEX] > 0) opaquePixels++;
      if ([0, 1, 2].some(channel => Math.abs(pixels[offset + channel] - pixels[channel]) > options.tolerance)) variedPixels++;
      options.colors.forEach((color, index) => {
        if (color.slice(0, RGB_CHANNEL_COUNT).every((value, channel) => Math.abs(pixels[offset + channel] - value) <= options.tolerance)) counts[index]++;
      });
    }
    return { width: image.naturalWidth, height: image.naturalHeight, blob: image.currentSrc.startsWith('blob:'), counts, variedPixels, opaquePixels, firstPixel: [...pixels.subarray(0, CHANNEL_COUNT)] };
  }, { colors, tolerance: PREVIEW_RGB_TOLERANCE, base64 });
}
async function previewReady(page, snapshot, requireImage) {
  if (!snapshot.itemCount) return await page.locator('.rb-public-wall__status[role="status"]').isVisible();
  const image = page.locator('.rb-public-wall__image');
  if (await image.isVisible() && await image.evaluate(node => node.complete && node.naturalWidth > 0)) return true;
  return !requireImage && await page.locator('.rb-public-wall__status[role="status"]').isVisible()
    && await page.locator('.rb-public-wall__scene').count() > 0;
}
async function checkPreviewImage(page, snapshot, requireRetroColors, imageFixture) {
  if (!(await page.locator('.rb-public-wall__image').isVisible())) return { kind: snapshot.itemCount ? 'dom-fallback' : 'empty-status' };
  const colors = snapshot.colors.map(index => {
    const { r, g, b } = parseColor(PALETTE[index].bg);
    return [r, g, b];
  });
  const expectedColors = [...colors, ...(imageFixture ? IMAGE_FIXTURE_COLORS : [])];
  let pixels;
  await eventually(async () => {
    pixels = await decodedImagePixels(page.locator('.rb-public-wall__image'), expectedColors);
    report.lastPreviewPixels = pixels;
    if (!pixels || pixels.variedPixels < PREVIEW_MIN_MATCHED_PIXELS) return false;
    const zoneCounts = pixels.counts.slice(0, colors.length);
    const imageCounts = pixels.counts.slice(colors.length);
    const zonesMatch = requireRetroColors ? zoneCounts.every(count => count >= PREVIEW_MIN_MATCHED_PIXELS)
      : !zoneCounts.length || zoneCounts.some(count => count >= PREVIEW_MIN_MATCHED_PIXELS);
    return zonesMatch && imageCounts.every(count => count >= PREVIEW_MIN_MATCHED_PIXELS);
  }, 'Actual decoded board PNG must be nonblank and retain required snapshot palette colors');
  assert.equal(pixels.width, PREVIEW_IMAGE_WIDTH_PX);
  assert.equal(pixels.height, PREVIEW_IMAGE_HEIGHT_PX);
  assert.equal(pixels.blob, true, 'Board preview must use its actual captured blob PNG');
  return { kind: 'png', ...pixels };
}
async function checkPublicPreview(requireRetroColors = true, imageFixture = null) {
  const landing = await participant(false, 'en');
  let completed = false;
  try {
    let snapshot;
    const snapshotReady = landing.page.waitForResponse(async response => {
      const candidate = await previewSnapshotState(response, requireRetroColors, imageFixture);
      if (!candidate) return false;
      snapshot = candidate;
      return true;
    }, { timeout: ACTION_TIMEOUT_MS });
    await landing.page.goto(baseUrl);
    await snapshotReady;
    await eventually(() => previewReady(landing.page, snapshot, requireRetroColors || !!imageFixture), 'Board snapshot image or legitimate read-only fallback must render');
    const image = await checkPreviewImage(landing.page, snapshot, requireRetroColors, imageFixture);
    assert.equal(await landing.page.locator('.rb-public-wall__zone, .rb-public-wall__preview > svg').count(), 0,
      'Preview must use the actual board scene rather than a manual gallery or SVG substitute');
    for (const size of [NARROW_MOBILE_VIEWPORT, DESKTOP_VIEWPORT]) {
      await landing.page.setViewportSize(size);
      await landing.page.waitForTimeout(LAYOUT_SETTLE_MS);
      const target = snapshot.itemCount ? landing.page.locator('.rb-public-wall__preview') : landing.page.locator('.rb-public-wall');
      const bounds = await target.evaluate(node => node.getBoundingClientRect().toJSON());
      assert.ok(bounds.left >= -EDGE_TOLERANCE_PX && bounds.right <= size.width + EDGE_TOLERANCE_PX);
      assert.equal(await landing.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false,
        'Actual board preview must not overflow the landing page');
      report.measurements.push({ mode: 'public-preview', size, bounds, image });
      await target.screenshot({ path: join(output, `${imageFixture ? 'public-image-preview' : 'public-preview'}-${size.width}.png`) });
    }
    completed = true;
  } finally {
    if (!completed) {
      const [capture] = await Promise.allSettled([captureFailurePage(landing.page, 'preview')]);
      report.previewFailure = capture.status === 'fulfilled' ? capture.value : { captureFailed: true };
    }
    await landing.context.close();
  }
}
async function checkTemplates(mobile, desktop, mode) {
  const originalPublicIds = mode === 'public' ? new Set((await readPublicSnapshot(mobile.page)).items.map(item => item.id)) : null;
  const originalZones = await zoneSnapshot(mobile);
  const before = originalZones.length;
  assert.deepEqual(await zoneSnapshot(desktop), originalZones);
  await mobile.page.locator('[data-tool="templates"]').tap();
  const sheet = mobile.page.locator('.rb-template-popover');
  await sheet.waitFor();
  const bounds = await sheet.evaluate(node => node.getBoundingClientRect().toJSON());
  assertWithinViewport(bounds, MOBILE_VIEWPORT, 'Template sheet');
  await sheet.getByRole('button', { name: /Retro Loop/ }).tap();
  for (const user of [mobile, desktop]) {
    await eventually(async () => (await zoneSnapshot(user)).length === before + RETRO_LOOP_ZONE_COUNT);
  }
  if (mode === 'public') {
    await checkPublicPreview();
    const added = (await readPublicSnapshot(mobile.page)).items.filter(item => item.type === 'zone' && !originalPublicIds.has(item.id));
    assert.equal(added.length, RETRO_LOOP_ZONE_COUNT);
    report.fixtureIds.push(...added.map(item => item.id));
  }
  await historyAction(mobile, 'undo');
  for (const user of [mobile, desktop]) {
    await eventually(async () => JSON.stringify(await zoneSnapshot(user)) === JSON.stringify(originalZones));
  }
}
async function checkHiddenCard(mobile, desktop, text) {
  await addDesktopCard(desktop, text, false);
  const hidden = mobile.page.locator('.rb-sticky').filter({ has: mobile.page.locator('.rb-sticky__hidden-title') });
  await hidden.waitFor();
  await fit(mobile);
  if (!(await targetUsable(mobile, await locatorBounds(hidden)))) {
    await frameTarget(mobile, await locatorBounds(hidden));
  }
  await eventually(async () => await targetUsable(mobile, await locatorBounds(hidden)),
    'Hidden fixture must be reachable before selection');
  await hidden.tap();
  assert.equal(await mobile.page.getByText(text, { exact: true }).count(), 0, 'Hidden text must not render');
  assert.equal(await mobile.page.getByRole('button', { name: WORDS[mobile.lang].edit, exact: true }).count(), 0, 'Other-user hidden card must not offer Edit');
  await cleanup(desktop, text);
  await hidden.waitFor({ state: 'hidden' });
}
async function simulateKeyboard(mobile, itemType = 'sticky') {
  await mobile.page.evaluate(({ height, top }) => {
    const viewport = window.visualViewport;
    window.__rbViewportCheckDescriptors = Object.fromEntries(['height', 'offsetTop'].map(key => [key, Object.getOwnPropertyDescriptor(viewport, key)]));
    Object.defineProperty(viewport, 'height', { configurable: true, value: height });
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
    viewport.dispatchEvent(new Event('resize'));
  }, { height: KEYBOARD_VIEWPORT_HEIGHT_PX, top: KEYBOARD_VIEWPORT_TOP_PX });
  await eventually(async () => {
    const editor = await mobile.page.locator('.rb-mobile-editor__input').evaluate((node, type) => ({
      inCard: type === 'sticky' ? !!node.closest('.rb-sticky')
        : !!node.closest('.rb-no-select') && node.parentElement.style.position === 'absolute',
      inDialog: !!node.closest('[role="dialog"]'), ...node.getBoundingClientRect().toJSON(),
    }), itemType);
    return editor.inCard && !editor.inDialog && editor.left >= -EDGE_TOLERANCE_PX
      && editor.right <= MOBILE_VIEWPORT.width + EDGE_TOLERANCE_PX
      && editor.top >= KEYBOARD_VIEWPORT_TOP_PX - EDGE_TOLERANCE_PX
      && editor.bottom <= KEYBOARD_VIEWPORT_TOP_PX + KEYBOARD_VIEWPORT_HEIGHT_PX + EDGE_TOLERANCE_PX;
  }, 'Inline editor must remain inside its card above the simulated keyboard');
  const done = await mobile.page.locator('.rb-mobile-editor__done').evaluate(node => node.getBoundingClientRect().toJSON());
  assert.ok(done.top >= KEYBOARD_VIEWPORT_TOP_PX && done.bottom <= KEYBOARD_VIEWPORT_TOP_PX + KEYBOARD_VIEWPORT_HEIGHT_PX,
    'Done must remain visible above simulated keyboard');
  assert.ok(done.width < MOBILE_VIEWPORT.width, 'Done must remain a compact control');
  const input = await mobile.page.locator('.rb-mobile-editor__input').evaluate(node => ({
    focused: document.activeElement === node, ...node.getBoundingClientRect().toJSON(),
  }));
  assert.equal(input.focused, true, 'Keyboard viewport updates must preserve inline input focus');
  const chrome = await mobile.page.evaluate(() => ['.rb-tool-dock', '.rb-zoom-controls', '.rb-selection-toolbar'].flatMap(selector => {
    const node = document.querySelector(selector);
    return node && node.getClientRects().length ? [{ selector, ...node.getBoundingClientRect().toJSON() }] : [];
  }));
  for (const box of chrome) {
    assert.equal(overlap(input, box), false, `Inline input must not overlap ${box.selector}`);
    assert.equal(overlap(done, box), false, `Done must not overlap ${box.selector}`);
  }

}
async function restoreViewport(mobile) {
  await mobile.page.evaluate(() => {
    for (const [key, descriptor] of Object.entries(window.__rbViewportCheckDescriptors)) {
      if (descriptor) Object.defineProperty(window.visualViewport, key, descriptor);
      else delete window.visualViewport[key];
    }
    delete window.__rbViewportCheckDescriptors;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
}
async function checkPinch(mobile) {
  const send = await touches(mobile);
  const initial = await viewport(mobile);
  const initialPoints = [{ id: 1, x: 140, y: 200 }, { id: 2, x: 240, y: 200 }];
  await send('touchStart', initialPoints.slice(0, 1));
  await send('touchStart', initialPoints);
  await send('touchMove', [{ id: 1, x: 100, y: 200 }, { id: 2, x: 280, y: 200 }]);
  await send('touchEnd', []);
  await mobile.page.waitForTimeout(LAYOUT_SETTLE_MS);
  const next = await viewport(mobile);
  assert.ok(next.zoom > initial.zoom);
  const browserScale = await mobile.page.evaluate(() => window.visualViewport.scale);
  assert.equal(browserScale, 1, 'Pinch must zoom board, not document');
  await mobile.page.locator('[data-tool="templates"]').tap();
  await mobile.page.locator('.rb-template-popover').waitFor();
  await closeTemplates(mobile);
}
async function checkInlineScroll(mobile, desktop, text) {
  const input = mobile.page.locator('.rb-mobile-editor__input');
  const lines = Array.from({ length: INLINE_SCROLL_LINE_COUNT }, (_, index) => `${text} line ${index + 1}`).join('\n');
  await input.fill(lines);
  await mobile.page.waitForTimeout(LAYOUT_SETTLE_MS);
  await restoreViewport(mobile);
  const beforeKeyboard = await geometry(mobile, text);
  await simulateKeyboard(mobile);
  await assertSharedGeometry(mobile, desktop, text, beforeKeyboard);
  await input.press(INPUT_START_SHORTCUT);
  const scroll = await input.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight, visible: node.clientHeight }));
  assert.ok(scroll.height > scroll.visible, 'Tall inline note must use bounded native textarea scrolling');
  if (engine === 'chromium') {
    // Trusted CDP touch exercises native textarea scrolling and ancestor touch-action.
    const box = await input.boundingBox();
    assert.ok(box.height >= TOUCH_MOVE_PX + INLINE_SCROLL_TOUCH_INSET_PX * 2, 'Inline input must fit the native swipe');
    await drag(mobile, { x: box.x + box.width / 2, y: box.y + box.height - INLINE_SCROLL_TOUCH_INSET_PX },
      { x: 0, y: -TOUCH_MOVE_PX });
  } else {
    // Mobile WebKit has no wheel support; native caret movement exercises textarea scrolling.
    await input.press(INPUT_END_SHORTCUT);
  }
  await eventually(async () => await input.evaluate(node => node.scrollTop) !== scroll.top,
    'Tall inline note must scroll through native input');
  await assertSharedGeometry(mobile, desktop, text, beforeKeyboard);
}
async function checkSelectionFollowsViewport(user, text, secondText = null) {
  if (!secondText) {
    const scroll = await user.page.evaluate(({ offset, delta }) => {
      const root = document.querySelector('.rb-no-select').parentElement;
      const marker = document.createElement('div');
      Object.assign(marker.style, { position: 'absolute', left: `${innerWidth + offset}px`, top: `${innerHeight + offset}px`, width: '1px', height: '1px' });
      root.append(marker);
      try { root.scrollTo(delta, delta); return { x: root.scrollLeft, y: root.scrollTop }; }
      finally { marker.remove(); root.scrollTo(0, 0); }
    }, { offset: NATIVE_SCROLL_PROBE_OFFSET_PX, delta: NATIVE_SCROLL_PROBE_DELTA_PX });
    assert.deepEqual(scroll, { x: 0, y: 0 }, 'Browser focus must not scroll the canvas container independently of its viewport');
  }
  await fit(user);
  await showText(user, text);
  await activate(user, card(user, text));
  if (secondText) await card(user, secondText).click({ modifiers: ['Shift'] });
  if (secondText) await user.page.locator('[data-selection-bounds="true"]').waitFor();
  else await eventually(() => selectedCornerMatches(user, card(user, text)));
  await user.page.waitForTimeout(LAYOUT_SETTLE_MS);
  const ids = [await card(user, text).getAttribute('data-sticky-id')];
  if (secondText) ids.push(await card(user, secondText).getAttribute('data-sticky-id'));
  const samples = await user.page.evaluate(async options => {
    const surface = document.querySelector('.rb-no-select');
    const samples = [];
    function drift() {
      const cards = [...document.querySelectorAll('[data-sticky-id]')].filter(node => options.ids.includes(node.dataset.stickyId)).map(node => node.getBoundingClientRect());
      const box = { left: Math.min(...cards.map(rect => rect.left)), top: Math.min(...cards.map(rect => rect.top)),
        right: Math.max(...cards.map(rect => rect.right)), bottom: Math.max(...cards.map(rect => rect.bottom)) };
      const expected = [[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]];
      const handles = [...document.querySelectorAll('[data-mobile-resize="true"]')];
      const handleError = handles.length !== expected.length ? Infinity : Math.max(...handles.map((node, index) => {
        const rect = node.getBoundingClientRect();
        return Math.hypot(rect.left + rect.width / 2 - expected[index][0], rect.top + rect.height / 2 - expected[index][1]);
      }));
      const toolbar = document.querySelector('.rb-selection-toolbar');
      let toolbarError = 0;
      if (!options.mobile && toolbar) {
        const rect = toolbar.getBoundingClientRect(), rail = document.querySelector('.rb-tool-dock').getBoundingClientRect();
        const anchorX = (box.left + box.right) / 2;
        const x = Math.max(rail.right + options.gap + rect.width / 2, Math.min(innerWidth - options.gap - rect.width / 2, anchorX));
        const y = Math.max(options.minY, box.top - options.gap);
        toolbarError = Math.hypot(rect.left + rect.width / 2 - x, rect.bottom - y);
      }
      return { handleError, toolbarError };
    }
    for (const zooming of [false, true]) {
      const errors = await new Promise(resolveFrames => {
        let count = 0; const errors = [];
        function frame() {
          errors.push(drift());
          if (++count === options.frames) return resolveFrames(errors);
          surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: zooming,
            deltaY: (count < options.frames / 2 ? 1 : -1) * (zooming ? options.zoomDelta : options.panDelta),
            clientX: innerWidth / 2, clientY: innerHeight / 2 }));
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
      samples.push({ zooming, maxHandleErrorPx: Math.max(...errors.map(row => row.handleError)),
        maxToolbarErrorPx: Math.max(...errors.map(row => row.toolbarError)) });
    }
    return samples;
  }, { ids, mobile: user.mobile, frames: SELECTION_FOLLOW_FRAME_COUNT, panDelta: SELECTION_PAN_DELTA_PX,
    zoomDelta: SELECTION_ZOOM_DELTA_Y, gap: SELECTION_TOOLBAR_GAP_PX, minY: TOOLBAR_MIN_ANCHOR_PX });
  report.measurements.push({ mode: 'selection-follow', mobile: user.mobile, group: Boolean(secondText), samples });
  for (const sample of samples) {
    assert.ok(sample.maxHandleErrorPx < SELECTION_FOLLOW_TOLERANCE_PX, `Selection handles drifted ${sample.maxHandleErrorPx}px during live viewport motion`);
    assert.ok(sample.maxToolbarErrorPx < SELECTION_FOLLOW_TOLERANCE_PX, `Selection toolbar drifted ${sample.maxToolbarErrorPx}px during live viewport motion`);
  }
  await user.page.waitForTimeout(LAYOUT_SETTLE_MS);
}

async function checkRemoteEditorCorners(observer, text) {
  await showText(observer, text);
  const target = card(observer, text);
  const initial = await viewport(observer);
  const bounds = await locatorBounds(target);
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const zoomAtCard = async zoom => {
    await observer.page.evaluate(({ zoom, point, sensitivity }) => {
      const surface = document.querySelector('.rb-no-select');
      const current = new DOMMatrix(getComputedStyle(surface.firstElementChild).transform).a;
      surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY: -Math.log(zoom / current) / sensitivity, clientX: point.x, clientY: point.y }));
    }, { zoom, point, sensitivity: PINCH_WHEEL_SENSITIVITY });
  };
  try {
    for (const zoom of PRESENCE_ZOOM_LEVELS) {
      await zoomAtCard(zoom);
      await eventually(() => target.evaluate((node, options) => {
        const surface = document.querySelector('.rb-no-select');
        const scale = new DOMMatrix(getComputedStyle(surface.firstElementChild).transform).a;
        const frame = [...surface.querySelectorAll('[aria-hidden="true"]')].find(candidate => candidate.style.zIndex === String(options.layer));
        if (!frame || Math.abs(scale - options.zoom) > options.zoomTolerance) return false;
        const cardStyle = getComputedStyle(node), frameStyle = getComputedStyle(frame);
        const actual = node.getBoundingClientRect(), outline = frame.getBoundingClientRect();
        const radiiMatch = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
          .every(key => Math.abs(parseFloat(cardStyle[key]) - parseFloat(frameStyle[key])) < options.radiusTolerance);
        return radiiMatch && Math.abs(parseFloat(frameStyle.borderTopWidth) * scale - options.borderWidth) < options.radiusTolerance
          && ['left', 'top', 'width', 'height'].every(key => Math.abs(actual[key] - outline[key]) < options.edgeTolerance);
      }, { zoom, layer: Z.REMOTE_EDITOR_BOX, zoomTolerance: PRESENCE_ZOOM_TOLERANCE,
        radiusTolerance: PRESENCE_RADIUS_TOLERANCE_PX, borderWidth: PRESENCE_BORDER_SCREEN_PX, edgeTolerance: EDGE_TOLERANCE_PX }),
      `Remote editing corners/bounds must match the card at zoom ${zoom}`);
    }
  } finally { await zoomAtCard(initial.zoom); }
}

async function checkEditing(mobile, desktop, text, mode) {
  await showText(mobile, text); await card(mobile, text).tap();
  const beforeKeyboard = await geometry(mobile, text);
  await mobile.page.getByRole('button', { name: WORDS[mobile.lang].edit, exact: true }).tap();
  const inline = await mobile.page.locator('.rb-mobile-editor__input').evaluate(node => ({ inCard: !!node.closest('.rb-sticky'), inDialog: !!node.closest('[role="dialog"]') }));
  assert.equal(inline.inCard, true, 'Mobile editing must stay inline in its sticky');
  assert.equal(inline.inDialog, false, 'Mobile editing must not open a modal');
  await mobile.page.screenshot({ path: join(output, `${mode}-inline.png`) });
  try {
    await checkRemoteEditorCorners(desktop, text);
    await simulateKeyboard(mobile);
    await assertSharedGeometry(mobile, desktop, text, beforeKeyboard);
    await checkInlineScroll(mobile, desktop, text);
    await mobile.page.screenshot({ path: join(output, `${mode}-inline-keyboard.png`) });
    const editor=mobile.page.locator('.rb-mobile-editor__input');
    assert.equal(await editor.evaluate(node=>getComputedStyle(node).userSelect),'text');
    await editor.selectText();
    const selection=await editor.evaluate(node=>({start:node.selectionStart,end:node.selectionEnd,length:node.value.length}));
    assert.equal(selection.start,0);assert.equal(selection.end,selection.length,'Native text selection still spans the editor value');
    await mobile.page.keyboard.insertText(`${text} edited`);
    await mobile.page.getByRole('button', { name: WORDS[mobile.lang].done, exact: true }).tap();
    await mobile.page.locator('.rb-mobile-editor__input').waitFor({ state: 'hidden' });
  } finally {
    await restoreViewport(mobile);
  }
  await showText(desktop, `${text} edited`);
}
async function textEditorGeometry(mobile) {
  return mobile.page.locator('.rb-mobile-editor__input').evaluate(node => {
    const item = node.parentElement;
    return { x: item.style.left, y: item.style.top, w: item.style.width, h: item.style.height };
  });
}
async function checkTextHighZoom(mobile, desktop, mode) {
  const text = `text-high-zoom-${mode}-${Date.now()}`;
  await mobile.page.locator('.rb-zoom-percentage').tap();
  for (let index = 0; index < TEXT_HIGH_ZOOM_CLICK_COUNT; index++) {
    await mobile.page.getByTitle(WORDS[mobile.lang].zoomIn, { exact: true }).tap();
  }
  assert.ok((await viewport(mobile)).zoom > 1, 'Text fixture must exercise zoom above 100%');
  await mobile.page.locator('[data-tool="text"]').tap();
  await mobile.page.locator('.rb-mobile-editor__input').fill(text);
  await mobile.page.getByRole('button', { name: WORDS[mobile.lang].done, exact: true }).tap();
  await mobile.page.locator('.rb-mobile-editor__input').waitFor({ state: 'hidden' });
  await mobile.page.getByRole('button', { name: WORDS[mobile.lang].edit, exact: true }).tap();
  const before = await textEditorGeometry(mobile);
  try {
    await simulateKeyboard(mobile, 'text');
    assert.deepEqual(await textEditorGeometry(mobile), before, 'Keyboard must not change canonical TextCard geometry');
    await mobile.page.screenshot({ path: join(output, `${mode}-text-high-zoom-keyboard.png`) });
    await mobile.page.getByRole('button', { name: WORDS[mobile.lang].done, exact: true }).tap();
    await mobile.page.locator('.rb-mobile-editor__input').waitFor({ state: 'hidden' });
  } finally {
    await restoreViewport(mobile);
  }
  await showText(desktop, text);
  await mobile.page.keyboard.press('Delete');
  for (const user of [mobile, desktop]) {
    await eventually(async () => await user.page.getByText(text, { exact: true }).count() === 0,
      'Own TextCard fixture deletion must converge');
  }
  await mobile.page.locator('.rb-zoom-percentage').tap();
}
async function checkReconnect(mobile, desktop, mode) {
  const text = `offline-${mode}-${Date.now()}`;
  try {
    await setMobileOffline(mobile, true);
    assert.equal(await mobile.page.evaluate(() => navigator.onLine), false);
    await addMobileCard(mobile, text, mode === 'private');
    await showText(mobile, text);
    await mobile.page.waitForTimeout(LAYOUT_SETTLE_MS);
    assert.equal(await desktop.page.getByText(text, { exact: true }).count(), 0,
      'Offline mobile edit must stay local until reconnect');
  } finally {
    await setMobileOffline(mobile, false);
  }
  assert.equal(await mobile.page.evaluate(() => navigator.onLine), true);
  await showText(desktop, text);
  await assertSharedGeometry(mobile, desktop, text, await geometry(mobile, text));
  await cleanup(desktop, text);
  await eventually(async () => await card(mobile, text).count() === 0);
}
function overlap(left, right) {
  return left.left < right.right - EDGE_TOLERANCE_PX && left.right > right.left + EDGE_TOLERANCE_PX
    && left.top < right.bottom - EDGE_TOLERANCE_PX && left.bottom > right.top + EDGE_TOLERANCE_PX;
}
async function checkToolReachability(user) {
  const tools = user.page.locator('.rb-tool-dock__body button[data-tool]');
  for (const tool of await tools.all()) {
    if (!(await tool.isVisible())) continue;
    await tool.scrollIntoViewIfNeeded();
    const target = await tool.evaluate(node => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { reachable: !!hit && node.contains(hit), ...box.toJSON() };
    });
    assert.equal(target.reachable, true, 'Every rail tool must be reachable after native scrolling');
    if (user.mobile) assert.ok(target.width >= TOUCH_TARGET_MIN_PX && target.height >= TOUCH_TARGET_MIN_PX,
      'Rail tools must keep touch-sized targets');
  }
}
async function checkTemplatePlacement(user) {
  const tool = user.page.locator('[data-tool="templates"]');
  await tool.scrollIntoViewIfNeeded();
  await activate(user, tool);
  const sheet = user.page.locator('.rb-template-popover');
  await sheet.waitFor();
  const bounds = await sheet.evaluate(node => node.getBoundingClientRect().toJSON());
  assertWithinViewport(bounds, user.page.viewportSize(), 'Template picker');
  if (!user.mobile) {
    const rail = await user.page.locator('.rb-tool-dock').evaluate(node => node.getBoundingClientRect().toJSON());
    assert.ok(bounds.left >= rail.right - EDGE_TOLERANCE_PX, 'Desktop Template picker must open to the right of the rail');
  }
  await closeTemplates(user);
}
async function checkRailLayout(user) {
  const size = user.page.viewportSize();
  const bounds = await user.page.evaluate(() => ['.rb-topbar', '.rb-tool-dock', '.rb-zoom-controls',
    '.rb-selection-toolbar', '.rb-mobile-edit-control', '.rb-mobile-editor__done'].flatMap(selector => {
    const node = document.querySelector(selector);
    return node && node.getClientRects().length ? [{ selector, ...node.getBoundingClientRect().toJSON() }] : [];
  }));
  for (const box of bounds) assertWithinViewport(box, size, box.selector);
  const rail = bounds.find(box => box.selector === '.rb-tool-dock');
  assert.ok(rail.right < size.width / 2 && rail.height > rail.width, 'Tool dock must form a vertical rail on the left');
  for (const box of bounds.filter(box => box !== rail)) assert.equal(overlap(rail, box), false, `Left rail must not overlap ${box.selector}`);
  const floating = bounds.filter(box => !['.rb-tool-dock', '.rb-topbar'].includes(box.selector));
  for (const [index, box] of floating.entries()) {
    for (const other of floating.slice(index + 1)) assert.equal(overlap(box, other), false, `${box.selector} must not overlap ${other.selector}`);
  }
  await checkToolReachability(user);
  await checkTemplatePlacement(user);
  return bounds;
}
async function checkLayout(mobile, mode) {
  for (const size of LAYOUT_VIEWPORTS) {
    await mobile.page.setViewportSize(size);
    await mobile.page.waitForTimeout(LAYOUT_SETTLE_MS);
    const bounds = await checkRailLayout(mobile);
    report.measurements.push({ mode, size, bounds });
    await mobile.page.screenshot({ path: join(output, `${mode}-${size.width}x${size.height}.png`) });
  }
  await mobile.page.setViewportSize(MOBILE_VIEWPORT);
}
async function selectedCornerMatches(user, target) {
  const item = await elementGeometry(target);
  const camera = await viewport(user);
  const canvas = await user.page.locator('.rb-no-select').boundingBox();
  const expected = { right: canvas.x + camera.x + (item.x + item.w) * camera.zoom,
    bottom: canvas.y + camera.y + (item.y + item.h) * camera.zoom };
  const handles = user.page.locator('[data-mobile-resize="true"]');
  if (await handles.count() === 0) return false;
  const corner = await handles.last().evaluate(node => node.getBoundingClientRect().toJSON());
  return Math.abs(corner.left + corner.width / 2 - expected.right) < EDGE_TOLERANCE_PX
    && Math.abs(corner.top + corner.height / 2 - expected.bottom) < EDGE_TOLERANCE_PX;
}
async function cleanupElement(user, target) {
  await showLocator(user, target);
  const box = await locatorBounds(target);
  assert.ok(await targetUsable(user, box), 'Cleanup click must hit the visible target card');
  // Locator click can scroll oversized transformed cards independently of fixed selection handles.
  await user.page.mouse.click(box.left + box.width / 2, box.top + box.height / 2);
  await eventually(() => selectedCornerMatches(user, target), 'Cleanup selection SE handle must match the target card before Delete');
  await user.page.keyboard.press('Delete');
  await eventually(async () => await target.count() === 0, 'Cleanup Delete must remove the item locally');
}
async function cleanup(user, text) {
  await showText(user, text);
  await cleanupElement(user, card(user, text));
}
const uploadedImage = (user, fixture) => user.page.locator(`.rb-no-select img[src$="/${fixture.src.split('/').at(-1)}"]`);
const uploadedImageItem = (user, fixture) => uploadedImage(user, fixture).locator('..');
async function readPublicSnapshot(page) {
  const response = await page.request.get(`${baseUrl}${PUBLIC_RELAY_PREFIX}${PUBLIC_SNAPSHOT_ROUTE}`);
  assert.ok(response.ok(), 'Public snapshot must remain available');
  return response.json();
}
async function imageFixtureBuffer(page) {
  const encoded = await page.evaluate(({ width, height, colors }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    colors.forEach((color, index) => {
      context.fillStyle = `rgb(${color.join(',')})`;
      context.fillRect(index * width / colors.length, 0, width / colors.length, height);
    });
    return canvas.toDataURL('image/png').split(',').at(-1);
  }, { width: IMAGE_FIXTURE_WIDTH_PX, height: IMAGE_FIXTURE_HEIGHT_PX, colors: IMAGE_FIXTURE_COLORS });
  return Buffer.from(encoded, 'base64');
}
async function uploadPublicImage(mobile) {
  const buffer = await imageFixtureBuffer(mobile.page);
  const tool = mobile.page.locator('[data-tool="image"]');
  await tool.scrollIntoViewIfNeeded();
  const chooserReady = mobile.page.waitForEvent('filechooser');
  await tool.tap();
  const chooser = await chooserReady;
  const uploadReady = mobile.page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.startsWith(`${PUBLIC_RELAY_PREFIX}/rooms/`)
    && new URL(response.url()).pathname.endsWith('/upload'));
  await chooser.setFiles({ name: `mobile-public-image-${Date.now()}.png`, mimeType: IMAGE_FIXTURE_MIME, buffer });
  const response = await uploadReady;
  assert.equal(response.status(), UPLOAD_SUCCESS_STATUS, 'Actual public image upload must return 200');
  assert.equal(await response.request().headerValue('content-type'), IMAGE_FIXTURE_MIME);
  const payload = await response.json();
  assert.match(payload.url, /^\/rooms\/[A-Za-z0-9_-]{32}\/images\/[a-fA-F0-9-]+\.png$/);
  const fixture = { src: `${PUBLIC_RELAY_PREFIX}${payload.url}`, id: null };
  const served = await mobile.page.request.get(`${baseUrl}${fixture.src}`);
  assert.equal(served.status(), UPLOAD_SUCCESS_STATUS);
  assert.match(served.headers()['content-type'], /^image\/png/);
  const bytes = await served.body();
  assert.deepEqual([...bytes.subarray(0, PNG_SIGNATURE_BYTES.length)], PNG_SIGNATURE_BYTES, 'Uploaded response source must serve actual PNG bytes');
  await eventually(async () => {
    const snapshot = await readPublicSnapshot(mobile.page);
    const matches = snapshot.items.filter(item => item.type === 'image' && item.src === fixture.src);
    assert.ok(matches.length <= 1, 'Own uploaded source must identify only one fixture item');
    fixture.id = matches[0]?.id || null;
    return !!fixture.id;
  }, 'Public snapshot must include the uploaded image item');
  report.fixtureIds.push(fixture.id);
  return fixture;
}
async function checkUploadedImageDecode(user, fixture) {
  await showLocator(user, uploadedImageItem(user, fixture));
  await eventually(async () => uploadedImage(user, fixture).evaluate((image, expected) => image.complete
    && image.naturalWidth === expected.width && image.naturalHeight === expected.height,
  { width: IMAGE_FIXTURE_WIDTH_PX, height: IMAGE_FIXTURE_HEIGHT_PX }),
  'Uploaded public image must decode at its original dimensions');
  const pixels = await decodedImagePixels(uploadedImage(user, fixture), IMAGE_FIXTURE_COLORS);
  assert.ok(pixels.counts.every(count => count >= PREVIEW_MIN_MATCHED_PIXELS), 'Decoded public image must retain both actual uploaded fixture colors');
}
async function assertImageGeometry(users, fixture, expected) {
  for (const user of users) await assertElementGeometry(uploadedImageItem(user, fixture), expected);
}
async function checkImageReverseEdit(mobile, desktop, fixture) {
  await showLocator(desktop, uploadedImageItem(desktop, fixture));
  const before = await elementGeometry(uploadedImageItem(desktop, fixture));
  const camera = await viewport(desktop);
  const box = await locatorBounds(uploadedImageItem(desktop, fixture));
  const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  await desktop.page.mouse.move(center.x, center.y);
  await desktop.page.mouse.down();
  await desktop.page.mouse.move(center.x + TOUCH_MOVE_PX, center.y + TOUCH_MOVE_PX, { steps: GESTURE_STEPS });
  await desktop.page.mouse.up();
  const expected = { ...before, x: before.x + TOUCH_MOVE_PX / camera.zoom, y: before.y + TOUCH_MOVE_PX / camera.zoom };
  await assertImageGeometry([desktop, mobile], fixture, expected);
  await historyAction(desktop, 'undo');
  await assertImageGeometry([desktop, mobile], fixture, before);
  await historyAction(desktop, 'redo');
  await assertImageGeometry([desktop, mobile], fixture, expected);
  return expected;
}
async function reloadPublicParticipant(user) {
  await user.page.reload({ waitUntil: 'domcontentloaded' });
  await user.page.locator('.rb-no-select').waitFor();
  const name = user.page.getByPlaceholder(WORDS[user.lang].name, { exact: true });
  if (await name.isVisible()) {
    await name.fill(`Mobile check ${user.lang}`);
    await activate(user, user.page.getByRole('button', { name: WORDS[user.lang].enter, exact: true }));
  }
  await closeTemplates(user);
}
async function cleanupUploadedImage(mobile, desktop, fixture) {
  const before = await readPublicSnapshot(mobile.page);
  assert.equal(before.items.find(item => item.id === fixture.id)?.src, fixture.src, 'Cleanup must target the exact own image ID/source');
  await cleanupElement(desktop, uploadedImageItem(desktop, fixture));
  for (const user of [mobile, desktop]) await eventually(async () => await uploadedImage(user, fixture).count() === 0);
  await eventually(async () => !(await readPublicSnapshot(mobile.page)).items.some(item => item.id === fixture.id),
    'Only the exact own uploaded image item must disappear from the snapshot');
  const retained = await mobile.page.request.get(`${baseUrl}${fixture.src}`);
  assert.equal(retained.status(), UPLOAD_SUCCESS_STATUS, 'Deleting an image item intentionally retains its uploaded file');
}
async function checkPublicImage(mobile, desktop) {
  const fixture = await uploadPublicImage(mobile);
  try {
    for (const user of [mobile, desktop]) await checkUploadedImageDecode(user, fixture);
    const expected = await checkImageReverseEdit(mobile, desktop, fixture);
    await reloadPublicParticipant(mobile);
    await checkUploadedImageDecode(mobile, fixture);
    await assertImageGeometry([mobile, desktop], fixture, expected);
    await checkPublicPreview(false, fixture);
    await mobile.page.screenshot({ path: join(output, 'public-image-mobile.png') });
  } finally {
    await cleanupUploadedImage(mobile, desktop, fixture);
  }
}
async function exitDrawing(user) {
  await activate(user, user.page.locator('[data-tool="draw"]'));
}
const drawingToolbar = user => user.page.locator('.rb-drawing-toolbar');
function drawingWord(user, key) { setLang(user.lang); return t(key); }
async function canonicalItems(user) { return user.page.evaluate(async () => (await window.storage.get('boardState', true)).value.items); }
async function drawingInk(user) {
  return user.page.locator('.rb-drawing-canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) ink++;
    return ink;
  });
}
async function openDrawing(user) {
  const tool = user.page.locator('[data-tool="draw"]');
  await tool.scrollIntoViewIfNeeded(); await activate(user, tool);
  await drawingToolbar(user).waitFor();
  assert.equal(await drawingToolbar(user).locator('.lucide-check').count(), 0, 'Drawing has no Done button');
  assert.equal(await user.page.locator('.rb-no-select').getByText(drawingWord(user, user.mobile ? 'mobile.emptyHint' : 'empty.hint'), { exact: true }).isVisible(), false, 'Empty-board hint must not cover the drawing surface');
  await activate(user, user.page.locator('.rb-zoom-percentage'));
}
async function settleDrawingPaint(user) {
  await user.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function drawStroke(user) {
  const start = { x: user.mobile ? 150 : 220, y: 350 };
  const end = { x: user.mobile ? 280 : 1000, y: 460 };
  if (!user.mobile) {
    await user.page.mouse.move(start.x, start.y); await user.page.mouse.down();
    await user.page.mouse.move(end.x, end.y, { steps: GESTURE_STEPS }); await user.page.mouse.up(); await settleDrawingPaint(user); return;
  }
  const send = await touches(user);
  await send('touchStart', [{ id: 1, ...start }]);
  for (let stepIndex = 1; stepIndex <= GESTURE_STEPS; stepIndex++) {
    const ratio = stepIndex / GESTURE_STEPS;
    await send('touchMove', [{ id: 1, x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }]);
  }
  await send('touchEnd', []);
  await settleDrawingPaint(user);
}
async function checkDrawingBounds(user) {
  await drawingToolbar(user).evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
  for (const width of user.mobile ? [360, 390] : [1440]) {
    const size = user.mobile ? { ...MOBILE_VIEWPORT, width } : DESKTOP_VIEWPORT;
    await user.page.setViewportSize(size);
    const boxes = await drawingToolbar(user).evaluate(element => [element, ...element.querySelectorAll('button, select')].map(node => node.getBoundingClientRect().toJSON()));
    report.measurements.push({ mode: 'drawing-toolbar', mobile: user.mobile, lang: user.lang, viewport: size, boxes });
    for (const box of boxes) assertWithinViewport(box, size, 'Drawing toolbar/control');
    if (user.mobile) for (const box of boxes.slice(1)) assert.ok(box.height >= TOUCH_TARGET_MIN_PX, `Drawing controls must be touch sized: ${box.height}px`);
    if (user.mobile) assert.ok(await drawingToolbar(user).locator('select').evaluateAll(elements => elements.every(element => parseFloat(getComputedStyle(element).fontSize) >= 16)), 'Mobile drawing selectors must avoid focus zoom');
    await user.page.screenshot({ path: join(output, `draw-${user.lang}-${width}.png`) });
  }
}
async function checkDraftHistory(user, peer, initialIds) {
  await openDrawing(user); await checkDrawingBounds(user);
  const toolbar = drawingToolbar(user);
  await toolbar.getByLabel(drawingWord(user, 'draw.color'), { exact: true }).selectOption(DRAWING_RED);
  await toolbar.getByLabel(drawingWord(user, 'draw.width'), { exact: true }).selectOption(String(DRAWING_STROKE_WIDTH_PX));
  await drawStroke(user);
  await eventually(async () => await drawingInk(user) > DRAWING_MIN_INK_PIXELS, 'Freehand draft must paint actual pixels');
  const ink = await drawingInk(user);
  await activate(user, toolbar.getByRole('button', { name: drawingWord(user, 'topbar.undo'), exact: true }));
  await eventually(async () => await drawingInk(user) === 0, 'Draft Undo must remove painted ink');
  await activate(user, toolbar.getByRole('button', { name: drawingWord(user, 'topbar.redo'), exact: true }));
  await eventually(async () => await drawingInk(user) === ink, 'Draft Redo must restore identical pixels');
  await eventually(async () => await previewInk(peer) > DRAWING_MIN_INK_PIXELS || await savedDrawingInk(peer,{excludedIds:initialIds}) > DRAWING_MIN_INK_PIXELS, 'Peer paints the completed stroke as a live preview or its saved PNG');
  await eventually(async () => (await canonicalItems(peer)).some(item => !initialIds.includes(item.id)), 'Drawing persists automatically without Done');
}
async function checkDrawingPinch(user) {
  const ink = await drawingInk(user), before = await viewport(user), send = await touches(user);
  await send('touchStart', [{ id: 1, x: 150, y: 550 }]);
  await send('touchStart', [{ id: 1, x: 150, y: 550 }, { id: 2, x: 250, y: 550 }]);
  await send('touchMove', [{ id: 1, x: 130, y: 550 }, { id: 2, x: 280, y: 550 }]);
  await send('touchEnd', []);
  assert.ok((await viewport(user)).zoom > before.zoom, 'Two fingers must zoom the live board');
  await activate(user, user.page.locator('.rb-zoom-percentage'));
  await eventually(async () => await drawingInk(user) > DRAWING_MIN_INK_PIXELS, 'Header zoom repaints the retained draft');
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'topbar.undo'), exact: true }));
  await eventually(async () => await drawingInk(user) === 0, 'Pinch must not leave an extra stroke after one Undo');
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'topbar.redo'), exact: true }));
  await eventually(async () => await drawingInk(user) >= Math.min(ink, DRAWING_MIN_INK_PIXELS), 'Redo restores the completed draft after pinch');
}
async function checkDrawingFailure(user) {
  const upload = '**/upload';
  await user.page.route(upload, route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await drawStroke(user);
  await exitDrawing(user);
  await drawingToolbar(user).getByRole('alert').waitFor();
  assert.ok(await drawingInk(user) > DRAWING_MIN_INK_PIXELS, 'Upload failure must preserve the draft');
  await user.page.unroute(upload);
}
async function checkDrawingPixels(user, fixture) {
  await showLocator(user, uploadedImageItem(user, fixture));
  const image = uploadedImage(user, fixture);
  await eventually(() => image.evaluate(node => node.complete && node.naturalWidth > 0));
  const pixels = await decodedImagePixels(image, [[220, 38, 38]]);
  assert.ok(pixels.counts[0] >= DRAWING_MIN_INK_PIXELS, 'Actual uploaded PNG must retain the chosen red ink');
  assert.ok(pixels.opaquePixels < pixels.width * pixels.height, 'Drawing must retain transparent background pixels');
}
async function checkDrawingExport(user, fixture) {
  const downloadReady = user.page.waitForEvent('download');
  await activate(user, user.page.getByTitle(drawingWord(user, 'topbar.more'), { exact: true }));
  await activate(user, user.page.locator('.rb-topbar-popover--more').getByRole('button', { name: drawingWord(user, 'topbar.export'), exact: true }));
  const download = await downloadReady, path = join(output, `drawing-${user.lang}.zip`);
  await download.saveAs(path);
  const reader = new ZipReader(new BlobReader(new Blob([await readFile(path)])));
  try {
    const entries = await reader.getEntries();
    const manifest = JSON.parse(await entries.find(entry => entry.filename === 'board.json').getData(new TextWriter()));
    const item = manifest.board.items.find(value => value.id === fixture.id);
    assert.ok(item, 'ZIP backup must include the canonical drawing');
    assert.ok(entries.some(entry => entry.filename === item.src), 'ZIP backup must include the actual drawing PNG bytes');
  } finally { await reader.close(); }
}
async function checkDrawingResize(user, peer, fixture) {
  const target = uploadedImageItem(user, fixture);
  await showLocator(user, target); await activate(user, target);
  const before = await elementGeometry(target);
  const handle = user.page.locator('[data-mobile-resize="true"]').last();
  const box = await handle.boundingBox();
  assert.ok(box, 'Saved drawing must have resize handles');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hit = await handle.evaluate(node => { const box=node.getBoundingClientRect(); const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2); return { own: hit===node, tag:hit?.tagName, class:typeof hit?.className==='string'?hit.className:null }; });
  report.measurements.push({mode:'drawing-resize-hit',mobile:user.mobile,hit});
  assert.equal(hit.own,true,`Resize handle must receive the gesture: ${hit.class}`);
  const delta = { x: TOUCH_MOVE_PX, y: TOUCH_MOVE_PX };
  if (user.mobile) await drag(user, start, delta);
  else {
    await user.page.mouse.move(start.x, start.y); await user.page.mouse.down();
    await user.page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: GESTURE_STEPS }); await user.page.mouse.up();
  }
  await eventually(async () => (await elementGeometry(target)).w > before.w, 'Saved drawing resize must change canonical width');
  const resized = await elementGeometry(target);
  await assertImageGeometry([user, peer], fixture, resized);
  await historyAction(user, 'undo'); await assertImageGeometry([user, peer], fixture, before);
  await historyAction(user, 'redo'); await assertImageGeometry([user, peer], fixture, resized);
}
async function canvasPointInk(user, point) {
  return user.page.locator('.rb-drawing-canvas').evaluate((canvas, point) => {
    const ratio = canvas.width / canvas.clientWidth;
    const data = canvas.getContext('2d').getImageData(Math.floor(point.x * ratio), Math.floor(point.y * ratio), 1, 1).data;
    return data[3];
  }, point);
}
async function shapeGesture(user, tool, start, end) {
  await activate(user, drawingToolbar(user).locator(`[data-drawing-tool="${tool}"]`));
  if (user.mobile) await drag(user, start, { x: end.x - start.x, y: end.y - start.y });
  else {
    await user.page.mouse.move(start.x, start.y); await user.page.mouse.down();
    await user.page.mouse.move(end.x, end.y, { steps: GESTURE_STEPS }); await user.page.mouse.up();
  }
}
async function checkShapeTools(user, peer = null) {
  const x = user.mobile ? 130 : 220;
  await drawingToolbar(user).getByLabel(drawingWord(user, 'draw.width'), { exact: true }).selectOption('4');
  await shapeGesture(user, 'rectangle', { x, y: 500 }, { x: x + 90, y: 560 });
  await eventually(async () => await canvasPointInk(user, { x, y: 530 }) > 0, 'Rectangle must paint its outline');
  assert.equal(await canvasPointInk(user, { x: x + 45, y: 530 }), 0, 'Rectangle interior stays transparent');
  const circleX = user.mobile ? 250 : 600;
  await shapeGesture(user, 'circle', { x: circleX, y: 500 }, { x: circleX + 50, y: 530 });
  await eventually(async () => await canvasPointInk(user, { x: circleX + 25, y: 500 }) > 0, 'Circle must keep circular geometry on a non-square drag');
  assert.equal(await canvasPointInk(user, { x: circleX + 25, y: 525 }), 0, 'Circle center stays transparent');
  await shapeGesture(user, 'arrow', { x, y: 650 }, { x: user.mobile ? 280 : 1000, y: 700 });
  if (peer) await checkLiveEraser(user, peer, { x, y: 530 });
  else await shapeGesture(user, 'eraser', { x: x - 20, y: 530 }, { x: x + 20, y: 530 });
  await eventually(async () => await canvasPointInk(user, { x, y: 530 }) === 0, 'Eraser clears actual alpha instead of painting a background color');
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'topbar.undo'), exact: true }));
  await eventually(async () => await canvasPointInk(user, { x, y: 530 }) > 0, 'Undo restores erased pixels');
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'topbar.redo'), exact: true }));
  await eventually(async () => await canvasPointInk(user, { x, y: 530 }) === 0, 'Redo erases again');
}
async function openSavedDrawing(user, fixture) {
  await showLocator(user, uploadedImageItem(user, fixture));
  await activate(user, uploadedImageItem(user, fixture));
  await activate(user, user.page.getByTitle(drawingWord(user, 'draw.editImage'), { exact: true }));
  await drawingToolbar(user).locator('[data-drawing-tool="eraser"]').waitFor();
}
async function savedInkPoint(user, fixture) {
  return uploadedImage(user, fixture).evaluate(async image => {
    const blob = await (await fetch(image.currentSrc, { credentials: 'include' })).blob();
    const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const bounds = image.getBoundingClientRect();
    const toolbarBottom = document.querySelector('.rb-drawing-toolbar').getBoundingClientRect().bottom;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] < 240) continue;
      const index = offset / 4, u = (index % canvas.width + 0.5) / canvas.width, v = (Math.floor(index / canvas.width) + 0.5) / canvas.height;
      const x = bounds.left + u * bounds.width, y = bounds.top + v * bounds.height;
      if (x > 110 && x < innerWidth - 30 && y > toolbarBottom + 30 && y < innerHeight - 120) return { x, y, u, v };
    }
    throw new Error('No reachable opaque drawing pixel');
  });
}
async function checkSavedDrawingEdit(user, peer, fixture) {
  const before = (await canonicalItems(user)).find(item => item.id === fixture.id);
  const itemCount = (await canonicalItems(user)).length;
  await openSavedDrawing(user, fixture);
  await eventually(() => drawingToolbar(user).locator('[data-drawing-tool="eraser"]').isEnabled(), 'Saved PNG must load through the actual room image API');
  assert.equal(await uploadedImageItem(user, fixture).evaluate(node => node.style.visibility), 'hidden', 'Original image must not show through erased draft pixels');
  const point = await savedInkPoint(user, fixture);
  await shapeGesture(user, 'eraser', point, { x: point.x + 2, y: point.y });
  await eventually(async () => await canvasPointInk(user, point) === 0, 'Saved bitmap pixels must erase');
  await exitDrawing(user);
  await drawingToolbar(user).waitFor({ state: 'hidden' });
  let edited;
  await eventually(async () => {
    edited = (await canonicalItems(user)).find(item => item.id === fixture.id);
    return edited?.src !== before.src && (await canonicalItems(peer)).find(item => item.id === fixture.id)?.src === edited.src;
  }, 'Saved drawing replacement must sync on the original ID');
  assert.equal((await canonicalItems(user)).length, itemCount);
  for (const field of ['x', 'y', 'w', 'h', 'authorId', 'authorName', 'createdAt']) assert.equal(edited[field], before[field], `Editing preserves ${field}`);
  assert.ok(edited.natW >= before.natW && edited.natH >= before.natH, 'Reopening at fit zoom must preserve raster quality');
  fixture.src = edited.src;
  const alpha = await uploadedImage(peer, fixture).evaluate(async (image, point) => {
    await image.decode(); const blob = await (await fetch(image.currentSrc, { credentials: 'include' })).blob();
    const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return ctx.getImageData(Math.floor(point.u * canvas.width), Math.floor(point.v * canvas.height), 1, 1).data[3];
  }, point);
  assert.equal(alpha, 0, 'Peer PNG must retain the erased alpha hole');
  await historyAction(user, 'undo'); await eventually(async () => (await canonicalItems(peer)).find(item => item.id === fixture.id)?.src === before.src);
  await historyAction(user, 'redo'); await eventually(async () => (await canonicalItems(peer)).find(item => item.id === fixture.id)?.src === edited.src);
  await openSavedDrawing(user, fixture);
  await eventually(() => drawingToolbar(user).locator('[data-drawing-tool="eraser"]').isEnabled());
  await shapeGesture(user, 'rectangle', { x: user.mobile ? 130 : 220, y: 400 }, { x: user.mobile ? 200 : 400, y: 450 });
  await peer.page.evaluate(id => { window.storage.updateItem(id, { x: 123.25 }); }, fixture.id);
  await eventually(async () => (await canonicalItems(user)).find(item => item.id === fixture.id)?.x === 123.25);
  await exitDrawing(user);
  await drawingToolbar(user).getByText(drawingWord(user, 'draw.conflict'), { exact: true }).waitFor();
  assert.equal((await canonicalItems(peer)).find(item => item.id === fixture.id).src, edited.src, 'Conflicting edit must not overwrite the peer image');
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'draw.cancel'), exact: true }));
  assert.equal(await uploadedImageItem(user, fixture).evaluate(node => node.style.visibility), '', 'Cancel restores the existing image');
}
async function checkSavedDrawingLoadRecovery(user, fixture) {
  const image = uploadedImage(user, fixture);
  await image.evaluate(node => node.decode());
  const routePattern = '**/images/*';
  await user.page.route(routePattern, route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await openSavedDrawing(user, fixture);
  await drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'draw.retryLoad'), exact: true }).waitFor();
  await user.page.unroute(routePattern);
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'draw.retryLoad'), exact: true }));
  await eventually(() => drawingToolbar(user).locator('[data-drawing-tool="eraser"]').isEnabled(), 'Image load failure must be retryable');
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'draw.cancel'), exact: true }));
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  await user.page.route(routePattern, route => started(route));
  await openSavedDrawing(user, fixture);
  const route = await requestStarted;
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'draw.cancel'), exact: true }));
  await route.abort(); await user.page.unroute(routePattern);
  await drawingToolbar(user).waitFor({ state: 'hidden' });
  assert.equal(await uploadedImageItem(user, fixture).evaluate(node => node.style.visibility), '', 'Cancel during loading must leave the original image visible');
}
async function saveAndCheckDrawing(user, peer, mode, initialIds) {
  await exitDrawing(user);
  await drawingToolbar(user).waitFor({ state: 'hidden' });
  let fixture;
  await eventually(async () => {
    fixture = (await canonicalItems(user)).find(item => !initialIds.includes(item.id));
    return fixture?.type === 'image' && (await canonicalItems(peer)).some(item => item.id === fixture.id);
  }, 'Saved drawing must become one canonical image on both peers');
  assert.equal((await canonicalItems(user)).length, initialIds.length + 1);
  report.fixtureIds.push(fixture.id);
  try {
    if (!user.mobile) assert.ok(fixture.w > ORDINARY_IMAGE_MAX_WORLD_PX, 'Large drawings keep world size without the ordinary image cap');
    for (const participant of [user, peer]) await checkDrawingPixels(participant, fixture);
    await historyAction(user, 'undo');
    await eventually(async () => { const previous = (await canonicalItems(peer)).find(item => item.id === fixture.id); return !previous || previous.src !== fixture.src; }, 'Undo reverses the latest automatic checkpoint');
    await historyAction(user, 'redo');
    await eventually(async () => (await canonicalItems(peer)).some(item => item.id === fixture.id && item.src === fixture.src));
    await checkImageReverseEdit(user, peer, fixture);
    await checkDrawingResize(user, peer, fixture);
    await reloadPublicParticipant(user); await checkDrawingPixels(user, fixture);
    await checkSavedDrawingEdit(user, peer, fixture);
    await checkSavedDrawingLoadRecovery(user, fixture);
    if (mode === 'public') {
      await eventually(async () => (await readPublicSnapshot(user.page)).items.some(item => item.id === fixture.id), 'Public snapshot must include the saved drawing');
      await checkDrawingExport(user, fixture);
    }
  } finally {
    await user.page.evaluate(id => window.storage.removeItem(id), fixture.id);
    await eventually(async () => !(await canonicalItems(peer)).some(item => item.id === fixture.id));
  }
}
async function checkDrawingCancellation(user, peer, initialIds) {
  await openDrawing(user); await drawStroke(user);
  let started;
  const waiting = new Promise(resolveStarted => { started = resolveStarted; });
  await user.page.route('**/upload', route => { started(route); });
  await exitDrawing(user);
  const route = await waiting;
  await activate(user, drawingToolbar(user).getByRole('button', { name: drawingWord(user, 'draw.cancel'), exact: true }));
  await route.abort(); await user.page.unroute('**/upload');
  await drawingToolbar(user).waitFor({ state: 'hidden' });
  await openDrawing(user);
  assert.equal(await drawingInk(user), 0, 'Cancel must discard the draft even while upload is pending');
  await user.page.keyboard.press('Escape'); await drawingToolbar(user).waitFor({ state: 'hidden' });
  assert.deepEqual((await canonicalItems(peer)).map(item => item.id).sort(), initialIds, 'Cancelled save must not create a ghost object');
}


async function savedDrawingInk(user, { point = null, excludedIds = [] } = {}) {
  return user.page.evaluate(async ({ point: world, excludedIds: excluded }) => {
    const ALPHA_CHANNEL_INDEX = 3, CHANNEL_COUNT = 4;
    const containsPoint = item => !world || (world.x >= item.x && world.y >= item.y && world.x < item.x + item.w && world.y < item.y + item.h);
    const countInk = bytes => {
      let ink = 0;
      for (let offset = ALPHA_CHANNEL_INDEX; offset < bytes.length; offset += CHANNEL_COUNT) if (bytes[offset]) ink++;
      return ink;
    };
    const bitmapInk = (bitmap, item) => {
      const canvas = document.createElement('canvas');
      try {
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        if (world) return ctx.getImageData(Math.floor((world.x - item.x) * bitmap.width / item.w), Math.floor((world.y - item.y) * bitmap.height / item.h), 1, 1).data[ALPHA_CHANNEL_INDEX];
        return countInk(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
    };
    const items = (await window.storage.get('boardState', true)).value.items;
    for (const item of items) {
      if (item.type !== 'image' || excluded.includes(item.id) || !containsPoint(item)) continue;
      const response = await fetch(item.src, { credentials: 'include' });
      if (!response.ok) continue;
      const ink = bitmapInk(await createImageBitmap(await response.blob()), item);
      if (ink) return ink;
    }
    return 0;
  },{point,excludedIds});
}

async function previewInk(user) {
  return user.page.locator('[data-drawing-preview]').evaluateAll(canvases => canvases.reduce((total, canvas) => {
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; for (let index = 3; index < bytes.length; index += 4) if (bytes[index]) count++;
    return total + count;
  }, 0));
}

async function previewPointInk(user, point) {
  return user.page.locator('[data-drawing-preview]').evaluateAll((canvases, world) => {
    for (const canvas of canvases) {
      const x = (world.x - parseFloat(canvas.style.left)) * canvas.width / parseFloat(canvas.style.width);
      const y = (world.y - parseFloat(canvas.style.top)) * canvas.height / parseFloat(canvas.style.height);
      if (x >= 0 && y >= 0 && x < canvas.width && y < canvas.height) return canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3];
    }
    return null;
  }, point);
}
async function checkLiveEraser(user, peer, point) {
  const camera = await viewport(user), world = { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom };
  await eventually(async () => {const live=await previewPointInk(peer,world);return(live??await savedDrawingInk(peer,{point:world}))>0;}, 'Peer sees the actual rectangle outline before erasing');
  await activate(user, drawingToolbar(user).locator('[data-drawing-tool="eraser"]'));
  let release;
  if (user.mobile) {
    const send = await touches(user); await send('touchStart', [{ id: 1, ...point }]);
    await send('touchMove', [{ id: 1, x: point.x + 20, y: point.y }]); release = () => send('touchEnd', []);
  } else {
    await user.page.mouse.move(point.x, point.y); await user.page.mouse.down();
    await user.page.mouse.move(point.x + 20, point.y); release = () => user.page.mouse.up();
  }
  await eventually(async () => await previewPointInk(peer, world) === 0, 'Peer sees a transparent eraser hole BEFORE mouseup');
  await release();
}

async function checkRealtimeDrag(user, peer) {
  const start = { x: user.mobile ? 150 : 220, y: 350 }, end = { x: user.mobile ? 280 : 750, y: 460 };
  let endGesture;
  if (user.mobile) {
    const send = await touches(user);
    await send('touchStart', [{ id: 1, ...start }]);
    await send('touchMove', [{ id: 1, ...end }]);
    endGesture = () => send('touchEnd', []);
  } else {
    await user.page.mouse.move(start.x, start.y); await user.page.mouse.down();
    await user.page.mouse.move(end.x, end.y, { steps: GESTURE_STEPS });
    endGesture = () => user.page.mouse.up();
  }
  await eventually(async () => await previewInk(peer) > DRAWING_MIN_INK_PIXELS, 'Peer must paint real ink BEFORE mouseup');
  await endGesture();
}

async function checkDrawingDeletion(user, peer) {
  const before=new Set((await canonicalItems(user)).map(item=>item.id));let fixture,release;
  try {
    await openDrawing(user);await drawStroke(user);
    await eventually(async()=>{fixture=(await canonicalItems(peer)).find(item=>!before.has(item.id));return !!fixture;},'Drawing saves before testing concurrent deletion');
    await eventually(async()=>await uploadedImageItem(peer,fixture).isVisible(),'A saved drawing remains selectable while its owner keeps Draw open');
    const start={x:user.mobile?150:220,y:350},end={x:user.mobile?280:750,y:460};
    if(user.mobile){const send=await touches(user);await send('touchStart',[{id:1,...start}]);await send('touchMove',[{id:1,...end}]);release=()=>send('touchEnd',[]);}
    else{await user.page.mouse.move(start.x,start.y);await user.page.mouse.down();await user.page.mouse.move(end.x,end.y,{steps:GESTURE_STEPS});release=()=>user.page.mouse.up();}
    await eventually(async()=>await previewInk(peer)>DRAWING_MIN_INK_PIXELS,'Next unfinished stroke is visible on the peer');
    await peer.page.evaluate(id=>window.storage.removeItem(id),fixture.id);
    await drawingToolbar(user).waitFor({state:'hidden'});
    await eventually(async()=>await peer.page.locator('[data-drawing-preview]').count()===0,'Deleting canonical ink must clear its live preview');
    for(const participant of [user,peer])assert.equal((await canonicalItems(participant)).some(item=>item.id===fixture.id),false);
    await release();release=null;
    await historyAction(peer,'undo');
    await eventually(async()=>(await canonicalItems(user)).some(item=>item.id===fixture.id),'Undo restores the deleted canonical PNG');
    assert.equal(await peer.page.locator('[data-drawing-preview]').count(),0,'Undo must not resurrect a disposed drawing preview');
    await historyAction(peer,'redo');await eventually(async()=>!(await canonicalItems(user)).some(item=>item.id===fixture.id));
    await step('drawing deletion: visible saved PNG, active-stroke cleanup, owner exit and peer Undo/Redo',async()=>{});
  }finally{
    await release?.();
    if(fixture)await peer.page.evaluate(id=>window.storage.removeItem(id),fixture.id);
  }
}

async function checkRealtimeDrawing(mobile, desktop, mode) {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname), 'Realtime fixtures are local only');
  for (const user of [desktop, mobile]) {
    const peer = user === desktop ? mobile : desktop;
    const before = new Set((await canonicalItems(user)).map(item => item.id));
    let fixture;
    try {
      await openDrawing(user); await checkDrawingBounds(user);
      await drawingToolbar(user).getByLabel(drawingWord(user, 'draw.color'), { exact: true }).selectOption(DRAWING_RED);
      await drawingToolbar(user).getByLabel(drawingWord(user, 'draw.width'), { exact: true }).selectOption(String(DRAWING_STROKE_WIDTH_PX));
      await checkRealtimeDrag(user, peer);
      await eventually(async () => {
        fixture = (await canonicalItems(peer)).find(item => !before.has(item.id)); return !!fixture;
      }, 'Completed stroke must persist automatically WITHOUT Done');
      assert.equal(await drawingToolbar(user).isVisible(), true);
      await eventually(async()=>await uploadedImageItem(peer,fixture).isVisible(),'Automatic checkpoint reveals its selectable PNG before Draw closes');
      await reloadPublicParticipant(peer);
      await eventually(async () => (await canonicalItems(peer)).some(item => item.id === fixture.id), 'Automatic save must survive a peer reload before Done');
      await checkShapeTools(user, peer);
      await eventually(async () => await previewInk(peer) > DRAWING_MIN_INK_PIXELS || await savedDrawingInk(peer,{excludedIds:[...before]}) > DRAWING_MIN_INK_PIXELS);
      await exitDrawing(user);
      await drawingToolbar(user).waitFor({ state: 'hidden' });
      await eventually(async () => await peer.page.locator('[data-drawing-preview]').count() === 0);
      const images = (await canonicalItems(peer)).filter(item => !before.has(item.id));
      assert.equal(images.length, 1, 'Repeated automatic saves update the same image'); fixture = images[0];
      for (const participant of [user, peer]) await checkDrawingPixels(participant, fixture);
      await checkImageReverseEdit(user, peer, fixture);
      await reloadPublicParticipant(peer); await checkDrawingPixels(peer, fixture);
      await checkSavedDrawingEdit(user, peer, fixture);
      await checkSavedDrawingLoadRecovery(user, fixture);
      if (mode === 'public') await checkDrawingExport(user, fixture);
      await step(`${mode}: ${user.mobile ? 'touch TH' : 'mouse EN'} live-before-mouseup/autosave/same-ID/eraser/history/reload`, async () => {});
    } finally {
      if (fixture) { await user.page.evaluate(id => window.storage.removeItem(id), fixture.id); await eventually(async () => !(await canonicalItems(peer)).some(item => item.id === fixture.id)); }
    }
    await checkDrawingDeletion(user,peer);
  }
}

async function checkDrawing(mobile, desktop, mode) {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname), 'Drawing fixtures are local only');
  const initialIds = (await canonicalItems(mobile)).map(item => item.id).sort();
  for (const user of [mobile, desktop]) {
    const peer = user === mobile ? desktop : mobile;
    await checkDraftHistory(user, peer, initialIds);
    if (user.mobile) await checkDrawingPinch(user);
    await checkShapeTools(user);
    await user.page.screenshot({ path: join(output, `draw-ready-${mode}-${user.lang}.png`) });
    await checkDrawingFailure(user);
    await user.page.screenshot({ path: join(output, `draw-ink-${mode}-${user.lang}.png`) });
    await saveAndCheckDrawing(user, peer, mode, initialIds);
    await checkDrawingCancellation(user, peer, initialIds);
  }
}
async function checkRoom(mode) {
  const desktop = await participant(false, 'en');
  const mobile = await participant(true, mode === 'public' ? 'th' : 'en');
  if (mode === 'private') await step('mobile landing: responsive bounds/Create/input size/safe area', () => checkLanding(mobile));
  const url = mode === 'private' ? await createPrivateRoom(mobile) : `${baseUrl}/public`;
  await enter(desktop, url);
  if (mode === 'public') await enter(mobile, url);
  await step(`${mode}: native mobile page selection/editor opt-in and unchanged desktop selection`,async()=>{await checkNativePageSelection(mobile);await checkNativePageSelection(desktop);});
  await step(`${mode}: Safari native pinch/wheel pan/anchor/both wheel settings/drawing surface`,()=>checkDesktopNativeGestures(desktop));
  await step(`${mode}: desktop left rail/tools/Template bounds`, () => checkRailLayout(desktop));
  await step(`${mode}: high-zoom TextCard inline keyboard/border bounds`, () => checkTextHighZoom(mobile, desktop, mode));
  if (mode === 'public') await step('public: image upload/decode/reverse edit/history/reload/snapshot/cleanup', () => checkPublicImage(mobile, desktop));
  await step(`${mode}: freehand draft/history/pinch/save/transparent PNG/sync/cancel`, () => roomMode === 'realtime' ? checkRealtimeDrawing(mobile, desktop, mode) : checkDrawing(mobile, desktop, mode));
  const textA = `mobile-${mode}-${Date.now()}`;
  const textB = `desktop-${mode}-${Date.now()}`;
  await step(`${mode}: mobile create/Done/sync`, async () => { await addMobileCard(mobile, textA, mode === 'private'); await showText(desktop, textA); });
  await step(`${mode}: touch drag`, () => checkDrag(mobile, desktop, textA));
  await step(`${mode}: touch resize/header Undo/Redo/sync`, () => checkResize(mobile, desktop, textA));
  await step(`${mode}: single selection stays attached during live pan/zoom`, () => checkSelectionFollowsViewport(mobile, textA));
  await step(`${mode}: anchored pinch/native buttons`, () => checkPinch(mobile));
  await step(`${mode}: inline Edit/simulated keyboard/Done/sync`, () => checkEditing(mobile, desktop, textA, mode));
  await step(`${mode}: desktop create/sync`, async () => { await addDesktopCard(desktop, textB, mode === 'private'); await showText(mobile, textB); });
  await step(`${mode}: group selection and toolbar stay attached during live pan/zoom`, () => checkSelectionFollowsViewport(desktop, `${textA} edited`, textB));
  await step(`${mode}: Template sheet/apply/sync/undo own zones`, () => checkTemplates(mobile, desktop, mode));
  if (mode === 'private') await step('private: hidden other-user card cannot edit', () => checkHiddenCard(mobile, desktop, `hidden-${Date.now()}`));
  await step(`${mode}: offline create/reconnect/sync/cleanup`, () => checkReconnect(mobile, desktop, mode));
  await step(`${mode}: responsive layout`, () => checkLayout(mobile, mode));
  await cleanup(desktop, `${textA} edited`); await cleanup(desktop, textB);
  await mobile.context.close(); await desktop.context.close();
}
async function captureFailurePage(page, index) {
  const diagnostics = await page.evaluate(() => ({
    online: navigator.onLine,
    preview: { images: document.querySelectorAll('.rb-public-wall__image').length,
      scenes: document.querySelectorAll('.rb-public-wall__scene').length, fonts: document.fonts.status,
      statuses: [...document.querySelectorAll('.rb-public-wall__status')].map(node => node.textContent),
      sourceImages: [...document.querySelectorAll('.rb-public-wall__scene img')].map(node => ({
        complete: node.complete, width: node.naturalWidth, height: node.naturalHeight,
        protocol: new URL(node.currentSrc || node.src, document.baseURI).protocol,
      })),
    },
    activeTag: document.activeElement?.tagName,
    activeClass: typeof document.activeElement?.className === 'string' ? document.activeElement.className : null,
    counts: Object.fromEntries(['.rb-sticky', '.rb-sticky--selected', '.rb-mobile-editor__input', '.rb-mobile-editor__done', '.rb-selection-toolbar',
      '.rb-sync-banner', '[role="dialog"]'].map(selector => [selector, document.querySelectorAll(selector).length])),
    itemBounds: [...document.querySelectorAll('.rb-sticky, [data-mobile-resize="true"]')].map(node => ({
      resizeHandle: node.matches('[data-mobile-resize="true"]'), ...node.getBoundingClientRect().toJSON(),
      paintTransform: getComputedStyle(node).transform, animation: getComputedStyle(node).animationName,
      geometry: { x: node.style.left, y: node.style.top, width: node.style.width, height: node.style.height },
    })),
    controls: ['.rb-tool-dock', '.rb-zoom-controls', '.rb-sync-banner'].flatMap(selector => {
      const node = document.querySelector(selector);
      return node ? [{ selector, ...node.getBoundingClientRect().toJSON() }] : [];
    }),
  }));
  await page.screenshot({ path: join(output, `failure-${index}.png`), mask: [page.locator('.rb-topbar-code')] });
  return { pageIndex: index, diagnostics };
}
async function captureFailure(error) {
  const pages = browser.contexts().flatMap(context => context.pages());
  const captures = await Promise.allSettled(pages.map(captureFailurePage));
  report.failure = { type: error.name, completedSteps: report.steps.length,
    pages: captures.map((capture, index) => capture.status === 'fulfilled' ? capture.value : { pageIndex: index, captureFailed: true }) };
}
try {
  if (roomMode === 'drawing' || roomMode === 'realtime') {
    for (const mode of ['private', 'public']) {
      const desktop = await participant(false, 'en'), mobile = await participant(true, 'th');
      const url = mode === 'private' ? await createPrivateRoom(mobile) : `${baseUrl}/public`;
      await enter(desktop, url); if (mode === 'public') await enter(mobile, url);
      await step(`${mode}: drawing desktop/mobile/two-context workflow`, () => roomMode === 'realtime' ? checkRealtimeDrawing(mobile, desktop, mode) : checkDrawing(mobile, desktop, mode));
      await mobile.context.close(); await desktop.context.close();
    }
  } else if (roomMode === 'preview') {
    await step('read-only actual board PNG/snapshot colors/responsive bounds', () => checkPublicPreview(false));
  } else {
    if (roomMode !== 'public') await checkRoom('private');
    if (roomMode !== 'private') await checkRoom('public');
  }
  assert.deepEqual(report.pageErrors, []);
} catch (error) {
  await captureFailure(error);
  throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
