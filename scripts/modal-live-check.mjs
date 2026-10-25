#!/usr/bin/env node
// Local browser regression for modal exits and mobile navbar/zone touch controls.
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { t, setLang } from '../src/client/ui/i18n.js';
import { ZONE_ICON_BUTTON_SIZE_PX, ZONE_ICON_GLYPH_SIZE_PX } from '../src/domain/zone-title.js';
import { ZONE_HEADER_TOOLS_BASE_FONT_PX } from '../src/client/board/zone-header-layout.js';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const PLAYWRIGHT_MODULE = '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const TIMEOUT_MS = 15_000;
const TOUCH_TARGET_PX = 44;
const PAGE_BOUNDARY_SELECTOR = 'html,body,#root';
const PAGE_BOUNDARY_NODE_COUNT = 3;
const EDGE_TOLERANCE_PX = 2;
const KEYBOARD_HEIGHT_PX = 340;
const KEYBOARD_TOP_PX = 24;
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const NARROW_WIDTHS_PX = [360, 390];
const ZONE_FIXTURE_ID = 'zone-tools-regression';
const ZONE_FIXTURE_TITLE = 'Zone tools regression';
const ZONE_WIDE_WIDTH_PX = 1280;
const ZONE_COMPACT_WIDTH_PX = 400;
const ZONE_TINY_WIDTH_PX = 160;
const ZONE_FIXTURE_HEIGHT_PX = 640;
const ZONE_FIXTURE_FONT_PX = 32;
const ZONE_MENU_INSET_PX = 16;
const ZONE_MENU_TOP_PX = 140;
const PAN_STEPS = 8;
const ZONE_FIXTURE_ORIGIN_PX = 120;
const TOUCH_FRAME_MS = 20;
const TOUCH_INSET_PX = 12;
const TOOL_VIEWPORT_WIDTHS_PX = [360, 390, 768, 1440];
const [baseArg, outputArg, engine = 'chromium'] = process.argv.slice(2);
const base = new URL(baseArg);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Use an isolated local server');
const output = resolve(outputArg);
assert.ok(output.startsWith(`${SSD_ROOT}/`), 'Artifacts must use the operator SSD');
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev, 'SSD must be mounted');
await mkdir(join(output, 'browser-temp'), { recursive: true });
process.env.TMPDIR = join(output, 'browser-temp');
const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || PLAYWRIGHT_MODULE).href);
assert.ok(['chromium', 'webkit'].includes(engine));
const browser = await playwright[engine].launch({ headless: true });
const report = { engine, steps: [], errors: [], measurements: [] };
const contexts = [];
function word(user, key) { setLang(user.lang); return t(key); }
async function step(name, action) { await action(); report.steps.push(name); console.log(`PASS ${name}`); }
async function participant(mobile, lang) {
  const context = await browser.newContext({ viewport: mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  contexts.push(context);
  await context.addInitScript(value => localStorage.setItem('rb_lang', value), lang);
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.on('pageerror', error => report.errors.push(error.message));
  return { page, mobile, lang };
}
async function activate(user, target) { if (user.mobile) await target.tap(); else await target.click(); }
function dialog(user) { return user.page.locator('.rb-modal').last(); }
function nameInput(user) { return user.page.getByPlaceholder(word(user, 'name.placeholder'), { exact: true }); }
async function dismiss(user, method) {
  if (method === 'escape') await user.page.keyboard.press('Escape');
  if (method === 'close') await activate(user, dialog(user).getByRole('button', { name: word(user, 'common.close'), exact: true }));
  await user.page.locator('.rb-modal').waitFor({ state: 'hidden' });
}
async function dismissBackdrop(user) {
  const target = dialog(user);
  if (user.mobile) await target.tap({ position: { x: 2, y: 2 } });
  else await target.click({ position: { x: 2, y: 2 } });
  await target.waitFor({ state: 'hidden' });
}
async function closeTemplates(user) {
  const popup = user.page.locator('.rb-template-popover');
  if (!await popup.isVisible()) return;
  if (user.mobile) await popup.getByRole('button', { name: word(user, 'common.close'), exact: true }).tap();
  else await user.page.locator('.rb-template-backdrop').click({ position: { x: 2, y: 2 } });
}
async function more(user, key) {
  await activate(user, user.page.getByTitle(word(user, 'topbar.more'), { exact: true }));
  await activate(user, user.page.locator('.rb-topbar-popover--more').getByRole('button', { name: word(user, key), exact: true }));
}
async function bounds(target) { return target.evaluate(node => node.getBoundingClientRect().toJSON()); }
async function checkPageBoundary(user) {
  const policies = await user.page.locator(PAGE_BOUNDARY_SELECTOR).evaluateAll(nodes => nodes.map(node => ({
    tag: node.tagName, x: getComputedStyle(node).overscrollBehaviorX, y: getComputedStyle(node).overscrollBehaviorY,
  })));
  assert.equal(policies.length, PAGE_BOUNDARY_NODE_COUNT);
  for (const policy of policies) {
    assert.equal(policy.x, 'none', 'Horizontal page navigation must remain suppressed');
    assert.equal(policy.y, 'none', 'Page boundaries must suppress pull-to-refresh');
  }
  report.measurements.push({ name: 'page-boundary', mobile: user.mobile, lang: user.lang, policies });
}
async function frameMeasurements(target) {
  return target.evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    return { selector: node.className, background: style.backgroundColor,
      border: style.borderTopColor, shadow: style.boxShadow };
  }));
}
async function checkTransparentFrames(target) {
  const frames = await frameMeasurements(target);
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.equal(frame.background, 'rgba(0, 0, 0, 0)', `${frame.selector} outer frame must be transparent`);
    assert.equal(frame.border, 'rgba(0, 0, 0, 0)');
    assert.equal(frame.shadow, 'none');
  }
  return frames;
}
async function checkToolSections(user) {
  const sections = await frameMeasurements(user.page.locator('.rb-topbar,.rb-tool-dock__body'));
  assert.equal(sections.length, 2, 'Navbar and left tools must each form a section');
  for (const section of sections) {
    const alpha = Number(section.background.match(/(?:\/|,)\s*([\d.]+)\)$/)?.[1]);
    assert.ok(alpha > 0 && alpha < 1, `${section.selector} must be translucent: ${section.background}`);
    assert.notEqual(section.border, 'rgba(0, 0, 0, 0)');
  }
  return sections;
}
async function checkIconPresentation(user) {
  const selectors = '.rb-zoom-controls,.rb-selection-toolbar';
  for (const theme of ['light', 'dark']) {
    await user.page.emulateMedia({ colorScheme: theme });
    await user.page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    await user.page.mouse.move(MOBILE_VIEWPORT.width / 2, MOBILE_VIEWPORT.height / 2);
    const frames = await checkTransparentFrames(user.page.locator(selectors));
    const sections = await checkToolSections(user);
    const icons = await user.page.locator('.rb-dock-tile__icon').evaluateAll(nodes => nodes.map(node => ({
      background: getComputedStyle(node).backgroundColor, artwork: node.style.backgroundColor,
    })));
    for (const icon of icons) {
      assert.ok(icon.artwork, 'Original colored icon artwork must remain');
      assert.equal(icon.background, icon.artwork);
    }
    assert.equal(await user.page.locator('.rb-dock-tile[aria-pressed="true"]').count(), 1);
    report.measurements.push({ name: 'outer-frames', theme, mobile: user.mobile, frames, sections, icons });
    await user.page.screenshot({ path: join(output, `icons-${user.lang}-${theme}.png`) });
  }
  await user.page.emulateMedia({ colorScheme: 'light' });
}
async function checkNavbar(user) {
  for (const width of NARROW_WIDTHS_PX) {
    await user.page.setViewportSize({ width, height: MOBILE_VIEWPORT.height });
    const menu = user.page.getByTitle(word(user, 'topbar.more'), { exact: true });
    const box = await bounds(menu);
    assert.ok(box.left >= 0 && box.right <= width, `More must be visible without scrolling at ${width}px: ${JSON.stringify(box)}`);
    assert.ok(box.width >= TOUCH_TARGET_PX && box.height >= TOUCH_TARGET_PX);
    await activate(user, menu);
    await activate(user, user.page.getByRole('button', { name: word(user, 'help.menuLabel'), exact: true }));
    await user.page.locator('#help-dialog-title').waitFor();
    await dismiss(user, 'close');
    report.measurements.push({ name: 'navbar', width, box });
  }
}
async function checkKeyboard(user) {
  await user.page.evaluate(({ height, top }) => {
    const viewport = window.visualViewport;
    window.__modalViewportDescriptors = Object.fromEntries(['height', 'offsetTop'].map(key => [key, Object.getOwnPropertyDescriptor(viewport, key)]));
    Object.defineProperty(viewport, 'height', { configurable: true, value: height });
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
    viewport.dispatchEvent(new Event('resize'));
  }, { height: KEYBOARD_HEIGHT_PX, top: KEYBOARD_TOP_PX });
  await user.page.waitForFunction(() => document.querySelector('.rb-modal').style.getPropertyValue('--rb-modal-viewport-height') === '340px');
  const close = await bounds(dialog(user).locator('.rb-modal__close'));
  const input = await bounds(dialog(user).locator('input,textarea').first());
  for (const box of [close, input]) {
    assert.ok(box.top >= KEYBOARD_TOP_PX - EDGE_TOLERANCE_PX && box.bottom <= KEYBOARD_TOP_PX + KEYBOARD_HEIGHT_PX + EDGE_TOLERANCE_PX, 'Input and close must remain above the keyboard');
  }
  assert.ok(close.width >= TOUCH_TARGET_PX && close.height >= TOUCH_TARGET_PX);
  report.measurements.push({ name: 'keyboard', close, input });
  await user.page.evaluate(() => {
    for (const [key, descriptor] of Object.entries(window.__modalViewportDescriptors)) {
      if (descriptor) Object.defineProperty(window.visualViewport, key, descriptor);
      else delete window.visualViewport[key];
    }
    delete window.__modalViewportDescriptors;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
}
async function checkName(user) {
  const edit = user.page.getByTitle(word(user, 'topbar.editName'), { exact: true });
  const original = await edit.innerText();
  for (const method of ['escape', 'close', 'backdrop']) {
    await activate(user, edit);
    await nameInput(user).fill('Discard this draft');
    if (method === 'backdrop') await dismissBackdrop(user);
    else await dismiss(user, method);
    assert.equal(await edit.innerText(), original, 'Cancel must preserve the saved display name');
  }
  await edit.focus();
  await edit.press('Enter');
  await checkKeyboard(user);
  const close = dialog(user).locator('.rb-modal__close');
  await close.focus();
  await user.page.keyboard.press('Tab');
  assert.equal(await nameInput(user).evaluate(node => node === document.activeElement), true);
  await user.page.keyboard.press('Shift+Tab');
  assert.equal(await close.evaluate(node => node === document.activeElement), true);
  await dismiss(user, 'escape');
  assert.equal(await edit.evaluate(node => node === document.activeElement), true, 'Dismissal must restore focus');
}
async function checkConfirmAndPin(user) {
  for (const method of ['escape', 'close', 'backdrop']) {
    await more(user, 'topbar.clear');
    await user.page.locator('#confirm-dialog-title').waitFor();
    if (method === 'backdrop') await dismissBackdrop(user);
    else await dismiss(user, method);
    await more(user, 'topbar.clear');
    await dialog(user).getByRole('button', { name: word(user, 'clear.confirm.ok'), exact: true }).click();
    await user.page.locator('#pin-dialog-title').waitFor();
    if (method === 'backdrop') await dismissBackdrop(user);
    else await dismiss(user, method);
  }
}
async function checkHelp(user) {
  await more(user, 'help.menuLabel');
  const content = dialog(user).locator('.rb-modal__content');
  await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const close = dialog(user).locator('.rb-modal__close');
  assert.ok((await bounds(close)).top >= 0, 'Long content must not scroll away Close');
  await user.page.screenshot({ path: join(output, `help-${user.lang}.png`) });
  await dismiss(user, 'escape');
}
function fixtureZone(user) {
  return user.page.locator('.rb-zone').filter({ has: user.page.locator('.rb-zone__label', { hasText: ZONE_FIXTURE_TITLE }) });
}
async function frameZoneMenu(user) {
  const menu = fixtureZone(user).locator('.rb-zone__menu');
  const before = await bounds(menu);
  const viewport = user.page.viewportSize();
  const center = { x: viewport.width / 2, y: viewport.height / 2 };
  await user.page.mouse.move(center.x, center.y);
  await user.page.mouse.down({ button: 'middle' });
  await user.page.mouse.move(center.x + viewport.width - ZONE_MENU_INSET_PX - before.right,
    center.y + ZONE_MENU_TOP_PX - before.top, { steps: PAN_STEPS });
  await user.page.mouse.up({ button: 'middle' });
  return menu;
}
async function resizeFixture(user, width, peer) {
  assert.equal(await peer.page.evaluate(({ id, w, right }) => window.storage.updateItem(id, { x: right - w, w }, { silent: true }), { id: ZONE_FIXTURE_ID, w: width, right: ZONE_FIXTURE_ORIGIN_PX + ZONE_WIDE_WIDTH_PX }), true);
  const resizeState = await user.page.evaluate(async ({ id, title }) => ({
    canonical: (await window.storage.get('boardState', true)).value.items.find(item => item.id === id)?.w,
    rendered: [...document.querySelectorAll('.rb-zone')].map(node => ({ title: node.querySelector('.rb-zone__label')?.textContent, width: node.style.width })).filter(row => row.title?.includes(title)),
  }), { id: ZONE_FIXTURE_ID, title: ZONE_FIXTURE_TITLE });
  report.measurements.push({ name: 'resize-fixture', targetWidth: width, ...resizeState });
  await user.page.waitForFunction(({ title, w }) => [...document.querySelectorAll('.rb-zone')]
    .some(node => node.querySelector('.rb-zone__label')?.textContent === title && parseFloat(node.style.width) === w),
  { title: ZONE_FIXTURE_TITLE, w: width });
}
async function assertScaledZoneTools(user) {
  const menu = fixtureZone(user).locator('.rb-zone__menu');
  const size = await menu.evaluate(node => ({
    button: parseFloat(getComputedStyle(node).width), glyph: parseFloat(getComputedStyle(node.querySelector('svg')).width),
    title: parseFloat(getComputedStyle(node).getPropertyValue('--rb-zone-title-size')),
    zoom: parseFloat(getComputedStyle(node).getPropertyValue('--rb-zone-canvas-zoom')),
    screen: node.getBoundingClientRect().width,
  }));
  const scale = size.title / ZONE_HEADER_TOOLS_BASE_FONT_PX;
  assert.ok(Math.abs(size.button - ZONE_ICON_BUTTON_SIZE_PX * scale) <= EDGE_TOLERANCE_PX);
  assert.ok(Math.abs(size.glyph - ZONE_ICON_GLYPH_SIZE_PX * scale) <= EDGE_TOLERANCE_PX);
  assert.ok(Math.abs(size.screen - size.button * size.zoom) <= EDGE_TOLERANCE_PX, 'Zone tools must scale with the board, rather than stay fixed on screen');
  report.measurements.push({ name: 'zone-tool-scale', ...size });
  return size;
}
async function checkInlineActions(user) {
  const zone = fixtureZone(user);
  assert.equal(await zone.locator('.rb-zone__admin-action:visible').count(), 2);
  const menu = await frameZoneMenu(user);
  await activate(user, menu);
  const strip = zone.locator('.rb-zone__tool-strip[data-state="open"]');
  await strip.waitFor();
  assert.equal(await user.page.locator('.rb-zone__tool-popup:visible').count(), 0, 'A wide zone must expand inline on every device');
  const rail = await bounds(user.page.locator('.rb-tool-dock'));
  const stripBox = await bounds(strip);
  assert.ok(stripBox.left >= rail.right && stripBox.right <= user.page.viewportSize().width);
  for (const control of await strip.locator('button').all()) {
    await control.scrollIntoViewIfNeeded();
    const reachability = await control.evaluate(node => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { reachable: node.contains(hit), title: node.title || node.getAttribute('aria-label'), box: box.toJSON(), hit: hit?.className };
    });
    report.measurements.push({ name: 'inline-tool-reachability', ...reachability });
    if (!reachability.reachable) await user.page.screenshot({ path: join(output, 'inline-hit-failure.png') });
    assert.equal(reachability.reachable, true, `Inline tool must be reachable: ${JSON.stringify(reachability)}`);
  }
  await user.page.screenshot({ path: join(output, `zone-inline-${user.page.viewportSize().width}.png`) });
  return strip;
}
async function checkTouchToolScroll(user, strip) {
  if (engine !== 'chromium') return;
  await strip.evaluate(node => { node.scrollLeft = 0; });
  const box = await bounds(strip);
  const session = await user.page.context().newCDPSession(user.page);
  const start = box.right - TOUCH_INSET_PX;
  const distance = box.width - TOUCH_INSET_PX * 2;
  const y = box.top + box.height / 2;
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
    for (let step = 1; step <= PAN_STEPS; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start - distance * step / PAN_STEPS, y }] });
      await user.page.waitForTimeout(TOUCH_FRAME_MS);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await user.page.waitForFunction(node => node.scrollLeft > 0, await strip.elementHandle());
    assert.equal(await strip.getAttribute('data-state'), 'open', 'A swipe must not activate a tool or close the strip');
    report.measurements.push({ name: 'trusted-zone-tool-swipe', scrollLeft: await strip.evaluate(node => node.scrollLeft) });
  } finally { await session.detach(); }
}
async function checkPopupFrame(user, popup) {
  for (const theme of ['light', 'dark']) {
    await user.page.emulateMedia({ colorScheme: theme });
    await user.page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    const frames = await checkTransparentFrames(popup);
    const colors = await popup.locator('.rb-color-swatch').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
    assert.ok(colors.length > 0);
    for (const color of colors) assert.notEqual(color, 'rgba(0, 0, 0, 0)', 'Palette colors must remain visible');
    report.measurements.push({ name: 'zone-popup-frame', theme, frames, colors });
    await user.page.screenshot({ path: join(output, `zone-popup-${theme}.png`) });
  }
  await user.page.emulateMedia({ colorScheme: 'light' });
}
async function checkZone(user, peer) {
  await user.page.evaluate(async fixture => {
    const ownerId = (await window.storage.get('userId', false)).value;
    if (!window.storage.addItems([{ ...fixture, ownerId }], { silent: true })) throw new Error('Local zone fixture was rejected');
  }, { id: ZONE_FIXTURE_ID, type: 'zone', title: ZONE_FIXTURE_TITLE, x: ZONE_FIXTURE_ORIGIN_PX, y: ZONE_FIXTURE_ORIGIN_PX,
    w: ZONE_WIDE_WIDTH_PX, h: ZONE_FIXTURE_HEIGHT_PX, fontSize: ZONE_FIXTURE_FONT_PX, color: 2 });
  await fixtureZone(user).waitFor();
  await fixtureZone(peer).waitFor();
  await activate(user, user.page.getByTitle(word(user, 'zoom.reset'), { exact: true }));
  for (const width of TOOL_VIEWPORT_WIDTHS_PX) {
    await user.page.setViewportSize({ width, height: MOBILE_VIEWPORT.height });
    await checkInlineActions(user);
    await assertScaledZoneTools(user);
    await user.page.keyboard.press('Escape');
    await fixtureZone(user).locator('.rb-zone__tool-strip').waitFor({ state: 'hidden' });
  }
  await user.page.setViewportSize(MOBILE_VIEWPORT);
  const openStrip = await checkInlineActions(user);
  await checkTouchToolScroll(user, openStrip);
  await activate(user, openStrip.getByRole('button', { name: word(user, 'selection.saveTemplate'), exact: true }));
  await user.page.locator('#template-dialog-title').waitFor();
  await dismiss(user, 'escape');
  await frameZoneMenu(user);
  await activate(user, fixtureZone(user).getByRole('button', { name: word(user, 'zone.startVote'), exact: true }));
  await user.page.locator('#vote-dialog-title').waitFor();
  await dismiss(user, 'escape');
  await checkInlineActions(user);
  await resizeFixture(user, ZONE_COMPACT_WIDTH_PX, peer);
  const popup = user.page.locator('.rb-zone__tool-popup[data-state="open"]');
  await popup.waitFor();
  assert.equal(await fixtureZone(user).locator('.rb-zone__admin-action:visible').count(), 2, 'A compact zone keeps its important tools when they still fit');
  assert.equal(await popup.getByRole('button', { name: word(user, 'zone.startVote'), exact: true }).count(), 0, 'Overflow must not duplicate visible primary tools');
  await user.page.screenshot({ path: join(output, 'zone-compact.png') });
  await resizeFixture(user, ZONE_WIDE_WIDTH_PX, peer);
  await popup.waitFor({ state: 'hidden' });
  await fixtureZone(user).locator('.rb-zone__tool-strip').waitFor();
  await user.page.keyboard.press('Escape');
  const before = await assertScaledZoneTools(user);
  await activate(user, user.page.getByTitle(word(user, 'zoom.out'), { exact: true }));
  const after = await assertScaledZoneTools(user);
  assert.ok(after.zoom < before.zoom && after.screen < before.screen, 'Zooming out must shrink zone tools');
  await checkInlineActions(user);
  await resizeFixture(user, ZONE_TINY_WIDTH_PX, peer);
  await popup.waitFor();
  assert.equal(await fixtureZone(user).locator('.rb-zone__admin-action:visible').count(), 0);
  const popupBounds = await bounds(popup);
  assert.ok(popupBounds.left >= 0 && popupBounds.right <= MOBILE_VIEWPORT.width && popupBounds.top >= 0 && popupBounds.bottom <= MOBILE_VIEWPORT.height);
  for (const button of await popup.locator('button').all()) {
    await button.scrollIntoViewIfNeeded();
    const target = await bounds(button);
    assert.ok(target.width >= TOUCH_TARGET_PX - EDGE_TOLERANCE_PX && target.height >= TOUCH_TARGET_PX - EDGE_TOLERANCE_PX);
  }
  await checkPopupFrame(user, popup);
  await user.page.screenshot({ path: join(output, 'zone-popup.png') });
  await activate(user, popup.getByRole('button', { name: word(user, 'selection.saveTemplate'), exact: true }));
  await user.page.locator('#template-dialog-title').waitFor();
  await checkKeyboard(user);
  await dismiss(user, 'close');
  report.measurements.push({ name: 'zone-options', popupBounds });
}
async function checkCommentsAndSync(mobile, desktop) {
  const text = `Modal regression ${Date.now()}`;
  await mobile.page.locator('[data-tool="sticky"]').tap();
  await mobile.page.locator('.rb-mobile-editor__input').fill(text);
  await mobile.page.getByRole('button', { name: word(mobile, 'mobile.done'), exact: true }).tap();
  await mobile.page.getByTitle(word(mobile, 'sticky.privacyToggle.off'), { exact: true }).tap();
  await desktop.page.getByText(text, { exact: true }).waitFor();
  const sticky = desktop.page.locator('.rb-sticky').filter({ hasText: text });
  await sticky.hover();
  await sticky.locator('.rb-sticky__comment-chip').click();
  await desktop.page.getByPlaceholder(word(desktop, 'comments.placeholder'), { exact: true }).fill('Comment kept');
  await desktop.page.keyboard.press('Control+Enter');
  await dialog(desktop).getByText('Comment kept', { exact: true }).waitFor();
  await dismiss(desktop, 'escape');
  await sticky.dblclick();
  const editor = sticky.locator('textarea');
  await editor.fill(`${text} peer`);
  await editor.press('Escape');
  await mobile.page.getByText(`${text} peer`, { exact: true }).waitFor();
  await desktop.page.getByTitle(word(desktop, 'topbar.undo'), { exact: true }).click();
  await mobile.page.getByText(text, { exact: true }).waitFor();
  await desktop.page.getByTitle(word(desktop, 'topbar.redo'), { exact: true }).click();
  await mobile.page.getByText(`${text} peer`, { exact: true }).waitFor();
}
async function checkPrivateEditingLock(owner, peer) {
  const sticky = peer.page.locator('.rb-sticky').first();
  const original = await sticky.innerText();
  await activate(owner, owner.page.getByRole('button', { name: word(owner, 'topbar.lockEdit'), exact: true }));
  await peer.page.waitForFunction(async () => (await window.storage.get('boardState', true)).value.editingLocked === true);
  await sticky.dblclick();
  assert.equal(await sticky.locator('textarea').count(), 0, 'Private guests cannot edit a locked board');
  await peer.page.keyboard.press('Control+z');
  assert.equal(await sticky.innerText(), original, 'Private guests cannot undo while locked');
  await owner.page.locator('[data-tool="sticky"]').tap();
  const text = `Private owner locked edit ${Date.now()}`;
  await owner.page.locator('.rb-mobile-editor__input').fill(text);
  await activate(owner, owner.page.getByRole('button', { name: word(owner, 'mobile.done'), exact: true }));
  await owner.page.getByTitle(word(owner, 'sticky.privacyToggle.off'), { exact: true }).tap();
  await peer.page.getByText(text, { exact: true }).waitFor();
  await activate(owner, owner.page.getByRole('button', { name: word(owner, 'topbar.unlockEdit'), exact: true }));
  await peer.page.waitForFunction(async () => (await window.storage.get('boardState', true)).value.editingLocked === false);
  const added = peer.page.locator('.rb-sticky').filter({ hasText: text });
  await added.dblclick();
  await added.locator('textarea').fill(`${text} guest`);
  await added.locator('textarea').press('Escape');
  await owner.page.getByText(`${text} guest`, { exact: true }).waitFor();
}

try {
  const mobile = await participant(true, 'en');
  await mobile.page.goto(base.href);
  await step('landing: page boundary suppresses pull-to-refresh', () => checkPageBoundary(mobile));
  await mobile.page.getByRole('button', { name: 'Create', exact: true }).click();
  await nameInput(mobile).waitFor();
  await mobile.page.screenshot({ path: join(output, 'name.png') });
  await step('first name: Escape continues as guest and survives reload', async () => {
    await dismiss(mobile, 'escape');
    assert.equal(await mobile.page.locator('.rb-template-popover').count(), 0, 'Entering a room must never open Templates automatically');
    await closeTemplates(mobile);
    await mobile.page.reload();
    await mobile.page.locator('.rb-no-select').waitFor();
    assert.equal(await mobile.page.locator('#name-dialog-title').count(), 0);
    assert.equal(await mobile.page.locator('.rb-template-popover').count(), 0, 'Reload must not reopen Templates');
    await closeTemplates(mobile);
  });
  await step('board: page boundary suppresses pull-to-refresh', () => checkPageBoundary(mobile));
  await step('tool frames: translucent navbar/rail sections, transparent floating tools and original colored icons in both themes', () => checkIconPresentation(mobile));
  await step('mobile navbar: visible More and tappable menu at 360/390px', () => checkNavbar(mobile));
  await step('name: cancel three ways, keyboard bounds, focus loop and restore', () => checkName(mobile));
  await step('confirmation and PIN: cancel three ways without destructive submission', () => checkConfirmAndPin(mobile));
  await step('help: scroll with a persistent Close control', () => checkHelp(mobile));
  const desktop = await participant(false, 'th');
  await desktop.page.goto(mobile.page.url());
  await nameInput(desktop).waitFor();
  await activate(desktop, desktop.page.getByRole('button', { name: word(desktop, 'name.skip'), exact: true }));
  await closeTemplates(desktop);
  await checkPageBoundary(desktop);
  await checkIconPresentation(desktop);
  await step('Thai desktop: guest skip, name cancellation and help', async () => { await checkName(desktop); await checkHelp(desktop); });
  await step('comments, two-way edits and undo/redo remain synchronized', () => checkCommentsAndSync(mobile, desktop));
  await step('private editing lock still blocks guests and allows the owner, with guest edits restored after unlock', () => checkPrivateEditingLock(mobile, desktop));
  await step('zone: primary tools, sliding inline actions, responsive popup, scaling and template cancel', () => checkZone(mobile, desktop));
  assert.deepEqual(report.errors, []);
} catch (error) {
  for (const [index, context] of contexts.entries()) {
    const page = context.pages()[0];
    await page.screenshot({ path: join(output, `failure-${index}.png`) });
    const board = await page.evaluate(async () => {
      const state = (await window.storage?.get('boardState', true))?.value;
      return { editingLocked: state?.editingLocked, items: state?.items.filter(item =>
        item.type === 'sticky' && item.text?.startsWith('Modal regression')).map(item =>
        ({ text: item.text, private: item.private, revealed: item.revealed })) };
    });
    report.measurements.push({ name: 'failure-state', context: index, board });
  }
  throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
}
