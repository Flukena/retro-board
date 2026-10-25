#!/usr/bin/env node
// Measures real UI spacing on isolated local servers; never uses a production room.
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setLang, t } from '../src/client/ui/i18n.js';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const PLAYWRIGHT_MODULE = '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const TIMEOUT_MS = 15_000;
const GRID_PX = 4;
const FRAME_PADDING_PX = 8;
const ROW_PADDING_PX = 12;
const CONTENT_PADDING_PX = 20;
const TOLERANCE_PX = 1;
const TOUCH_TARGET_PX = 44;
const CASES = [
  { width: 360, height: 800, lang: 'th', mobile: true },
  { width: 390, height: 844, lang: 'en', mobile: true, publicRoom: true },
  { width: 768, height: 1024, lang: 'th', mobile: true },
  { width: 1440, height: 900, lang: 'en', mobile: false },
];
const SELECTORS = ['.rb-landing__card', '.rb-landing__action', '.rb-public-wall__join',
  '.rb-topbar', '.rb-topbar-scroll', '.rb-surface', '.rb-menu-item', '.rb-modal__content', '.rb-dialog__actions',
  '.rb-dialog__body', '.rb-dialog__heading', '.rb-dialog__header', '.rb-zone__tool-popup',
  '.rb-zone__tool-popup .rb-zone__icon', '.rb-timer-setup__presets', '.rb-timer-setup__options', '.rb-timer-dock',
  '.rb-results', '.rb-results__stat', '.rb-landing__recent', '.rb-selection-toolbar'];
const [baseArg, outArg, engine = 'chromium', mode = 'check', widthArg] = process.argv.slice(2);
assert.ok(baseArg && outArg, 'Pass a local URL and BaseData output directory');
const base = new URL(baseArg);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Only isolated local servers are supported');
assert.ok(['chromium', 'webkit'].includes(engine));
assert.ok(['check', 'audit'].includes(mode));
const selectedCases = widthArg ? CASES.filter(settings => settings.width === Number(widthArg)) : CASES;
assert.ok(selectedCases.length > 0, 'Choose a supported viewport width');
const out = resolve(outArg);
assert.ok(out.startsWith(`${SSD_ROOT}/`));
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev);
await mkdir(join(out, 'scratch'), { recursive: true });
process.env.TMPDIR = join(out, 'scratch');
const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || PLAYWRIGHT_MODULE).href);
const browser = await playwright[engine].launch({ headless: true });
const report = { engine, mode, errors: [], scenes: [], findings: [] };
function word(user, key) { setLang(user.lang); return t(key); }
async function activate(user, target) { if (user.mobile) await target.tap(); else await target.click(); }
function near(value, expected) { return Math.abs(value - expected) <= TOLERANCE_PX; }
function finding(ok, scene, message) { if (!ok) report.findings.push(`${scene}: ${message}`); }
function checkSpacing(scene, nodes) {
  for (const node of nodes) {
    const [top, right, bottom, left] = node.padding;
    const label = `${scene} ${node.selector}`;
    if (node.selector === '.rb-topbar-scroll') {
      finding(node.overflowY === 'hidden', label, 'navbar must disable vertical scrolling');
      finding(node.overflowX === 'auto', label, 'mobile navbar must retain horizontal access');
      finding(node.scrollHeight === node.clientHeight, label, 'navbar controls must fit vertically');
    }
    finding(near(left, right), label, `unequal horizontal padding ${left}/${right}px`);
    if (node.selector === '.rb-landing__card' || node.selector === '.rb-modal__content') {
      finding(near(left, CONTENT_PADDING_PX), label, `content inset ${left}px; expected ${CONTENT_PADDING_PX}px`);
    }
    if (['.rb-menu-item', '.rb-zone__tool-popup .rb-zone__icon'].includes(node.selector)) {
      finding(near(left, ROW_PADDING_PX), label, `menu row inset ${left}px; expected ${ROW_PADDING_PX}px`);
      finding(near(top, FRAME_PADDING_PX) && near(bottom, FRAME_PADDING_PX), label, `row vertical padding ${top}/${bottom}px`);
    }
    if (node.isMenuFrame) finding(node.padding.every(value => near(value, FRAME_PADDING_PX)), label, `menu frame padding ${node.padding.join('/')}px`);
    for (const value of node.padding) finding(near(value % GRID_PX, 0), label, `padding ${value}px is outside the ${GRID_PX}px rhythm`);
  }
}
async function capture(user, name) {
  const scene = `${user.width}-${user.lang}-${name}`;
  const nodes = await user.page.evaluate(selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].flatMap(node => {
    if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return [];
    const css = getComputedStyle(node);
    return [{ selector, padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(parseFloat),
      gap: css.gap, marginBottom: css.marginBottom, overflowY: css.overflowY, overflowX: css.overflowX,
      scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      isMenuFrame: node.matches('.rb-template-popover, .rb-topbar-popover'),
      width: node.getBoundingClientRect().width }];
  })), SELECTORS);
  checkSpacing(scene, nodes);
  report.scenes.push({ scene, nodes });
  await user.page.screenshot({ path: join(out, `${scene}.png`) });
}
async function dismiss(user) {
  await activate(user, user.page.locator('.rb-modal__close'));
  await user.page.locator('.rb-modal').waitFor({ state: 'hidden' });
}
async function more(user, key) {
  await activate(user, user.page.getByTitle(word(user, 'topbar.more'), { exact: true }));
  await activate(user, user.page.locator('.rb-topbar-popover--more').getByRole('button', { name: word(user, key), exact: true }));
}
async function checkNavbarScroll(user) {
  if (!user.mobile) return;
  const scroll = user.page.locator('.rb-topbar-scroll');
  if (engine === 'chromium') {
    await scroll.hover();
    await user.page.mouse.wheel(0, 360);
  } else {
    await scroll.evaluate(node => { node.tabIndex = 0; node.focus(); });
    await user.page.keyboard.press('PageDown');
    await scroll.evaluate(node => node.removeAttribute('tabindex'));
  }
  await user.page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  const y = await scroll.evaluate(node => node.scrollTop);
  finding(y === 0, `${user.width} navbar`, `vertical scroll gesture moved navbar to ${y}px`);
}
async function boardFixtures(user) {
  await user.page.evaluate(async () => {
    const ownerId = (await window.storage.get('userId', false)).value;
    if (!window.storage.addItems([
      { id: 'spacing-zone', type: 'zone', x: 108, y: 120, w: 240, h: 400, title: 'Spacing zone', color: 2, ownerId },
      { id: 'spacing-note', type: 'sticky', x: 130, y: 220, w: 180, h: 160, text: 'Spacing note', color: 0, ownerId, private: false },
    ])) throw new Error('Local spacing fixtures were rejected');
  });
  await user.page.locator('.rb-zone__menu').waitFor();
}
async function zoneMenu(user) {
  await activate(user, user.page.locator('.rb-zone__menu'));
  const popup = user.page.locator('.rb-zone__tool-popup[data-state="open"]');
  await popup.waitFor();
  return popup;
}
async function checkVoteExits(user) {
  for (const method of ['close', 'escape', 'backdrop']) {
    if (method === 'close') await dismiss(user);
    if (method === 'escape') await user.page.keyboard.press('Escape');
    if (method === 'backdrop') {
      const backdrop = user.page.locator('.rb-timer-setup');
      if (user.mobile) await backdrop.tap({ position: { x: 2, y: 2 } });
      else await backdrop.click({ position: { x: 2, y: 2 } });
    }
    await user.page.locator('.rb-timer-setup').waitFor({ state: 'hidden' });
    const popup = await zoneMenu(user);
    await activate(user, popup.getByRole('button', { name: word(user, 'zone.startVote'), exact: true }));
    await user.page.locator('.rb-timer-setup').waitFor();
  }
}
async function checkWidgets(user) {
  await boardFixtures(user);
  let popup = await zoneMenu(user);
  await capture(user, 'zone-menu');
  await activate(user, popup.getByRole('button', { name: word(user, 'selection.saveTemplate'), exact: true }));
  await capture(user, 'template-name');
  await dismiss(user);
  const sticky = user.page.locator('.rb-sticky');
  await sticky.hover();
  await activate(user, sticky.locator('.rb-sticky__comment-chip'));
  await capture(user, 'comments');
  await dismiss(user);
  popup = await zoneMenu(user);
  await activate(user, popup.getByRole('button', { name: word(user, 'zone.startVote'), exact: true }));
  await capture(user, 'timer-setup');
  for (const control of await user.page.locator('.rb-timer-setup .rb-choice-chip').all()) {
    const reachable = await control.evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    finding(reachable, `${user.width} vote setup`, 'preset control is covered by another panel');
  }
  if (user.mobile) {
    for (const input of await user.page.locator('.rb-timer-setup__number').all()) {
      const height = await input.evaluate(node => node.getBoundingClientRect().height);
      finding(near(height, TOUCH_TARGET_PX), `${user.width} vote setup`, `numeric field height ${height}px must match ${TOUCH_TARGET_PX}px preset buttons`);
    }
  }
  await checkVoteExits(user);
  await activate(user, user.page.locator('.rb-timer-setup').getByRole('button', { name: word(user, 'vote.setup.start'), exact: true }));
  await user.page.locator('.rb-timer-dock').waitFor();
  await capture(user, 'timer');
  await activate(user, user.page.locator('.rb-timer-dock').getByRole('button', { name: word(user, 'topbar.stopVote'), exact: true }));
  await user.page.locator('.rb-results').waitFor();
  await capture(user, 'results');
}
async function checkCase(settings) {
  const context = await browser.newContext({ viewport: { width: settings.width, height: settings.height }, isMobile: settings.mobile,
    hasTouch: settings.mobile, reducedMotion: 'reduce' });
  try {
    await context.addInitScript(lang => localStorage.setItem('rb_lang', lang), settings.lang);
    const user = { ...settings, page: await context.newPage() };
    user.page.setDefaultTimeout(TIMEOUT_MS);
    user.page.on('pageerror', error => report.errors.push(error.message));
    await user.page.goto(base.href);
    await user.page.locator('.rb-public-wall').waitFor();
    await capture(user, 'landing');
    const create = user.page.getByRole('button', { name: 'Create', exact: true });
    const join = user.page.locator('.rb-public-wall__join');
    const heights = await Promise.all([create, join].map(target => target.evaluate(node => node.getBoundingClientRect().height)));
    finding(near(heights[0], heights[1]), `${settings.width} landing`, `Create/Public actions have different heights ${heights.join('/')}px`);
    if (user.publicRoom) await user.page.goto(new URL('/public', base).href);
    else await activate(user, create);
    await user.page.locator('#name-dialog-title').waitFor();
    await capture(user, 'name');
    await dismiss(user);
    await checkNavbarScroll(user);
    await activate(user, user.page.getByTitle(word(user, 'topbar.more'), { exact: true }));
    await capture(user, 'more');
    await activate(user, user.page.getByRole('button', { name: word(user, 'help.menuLabel'), exact: true }));
    await capture(user, 'help');
    await dismiss(user);
    await activate(user, user.page.getByRole('button', { name: word(user, 'tmpl.btn'), exact: true }));
    await capture(user, 'templates');
    if (user.mobile) await activate(user, user.page.locator('.rb-template-popover').getByRole('button', { name: word(user, 'common.close'), exact: true }));
    else await user.page.locator('.rb-template-backdrop').click({ position: { x: 2, y: 2 } });
    await more(user, 'topbar.clear');
    await capture(user, 'confirm');
    if (!user.publicRoom) {
      await activate(user, user.page.locator('.rb-modal').getByRole('button', { name: word(user, 'clear.confirm.ok'), exact: true }));
      await capture(user, 'pin');
    }
    await dismiss(user);
    await checkWidgets(user);
    if (user.publicRoom) await user.page.evaluate(() => {
      window.storage.removeItem('spacing-zone');
      window.storage.removeItem('spacing-note');
    });
    await activate(user, user.page.getByTitle(word(user, 'topbar.home'), { exact: true }));
    if (!user.publicRoom) {
      await user.page.locator('.rb-landing__card--recents').waitFor();
      await capture(user, 'recents');
    }
    console.log(`PASS captured ${settings.width}px ${settings.lang}`);
  } finally { await context.close(); }
}
try {
  for (const settings of selectedCases) await checkCase(settings);
  assert.deepEqual(report.errors, []);
  if (mode === 'check') assert.equal(report.findings.length, 0, `Spacing must be consistent across equivalent UI roles: ${report.findings.slice(0, 6).join('; ')}`);
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
