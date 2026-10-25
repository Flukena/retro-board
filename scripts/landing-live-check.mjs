#!/usr/bin/env node
// Read-only landing regression. Recent entries exist only in isolated browser profiles.
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setLang, t } from '../src/client/ui/i18n.js';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const PLAYWRIGHT_MODULE = '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const TIMEOUT_MS = 15_000;
const EDGE_TOLERANCE_PX = 1;
const TOUCH_TARGET_MIN_PX = 44;
const MOBILE_INPUT_MIN_FONT_PX = 16;
const RECENT_FIXTURE_COUNT = 10;
const VISIT_STEP_MS = 1000;
const CODE_DIGIT_COUNT = 7;
const SCROLL_FRAME_COUNT = 24;
const KEYBOARD_VIEWPORT_HEIGHT_PX = 420;
const CASES = [
  { name: 'desktop', width: 1440, height: 1000, lang: 'en', theme: 'light' },
  { name: 'dark', width: 1440, height: 1000, lang: 'en', theme: 'dark' },
  { name: 'phone-small', width: 320, height: 720, lang: 'th', theme: 'light' },
  { name: 'phone', width: 390, height: 844, lang: 'th', theme: 'light' },
  { name: 'phone-large', width: 430, height: 932, lang: 'en', theme: 'light' },
  { name: 'tablet', width: 768, height: 1024, lang: 'th', theme: 'light' },
  { name: 'landscape', width: 844, height: 390, lang: 'th', theme: 'light' },
];
const [baseArg, outputArg, engine = 'chromium'] = process.argv.slice(2);
assert.ok(baseArg && outputArg, 'Pass base URL and SSD output directory');
const base = new URL(baseArg);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname) || base.origin === 'https://retroroom.party');
const output = resolve(outputArg);
assert.ok(output.startsWith(`${SSD_ROOT}/`));
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev, 'SSD must be mounted');
assert.ok(['chromium', 'webkit'].includes(engine));
await mkdir(join(output, 'browser-temp'), { recursive: true });
process.env.TMPDIR = join(output, 'browser-temp');
const playwright = await import(pathToFileURL(PLAYWRIGHT_MODULE).href);
const browser = await playwright[engine].launch({ headless: true });
const report = { ts: new Date().toISOString(), engine, cases: [], errors: [], writes: 0 };

function fixtures() {
  return Array.from({ length: RECENT_FIXTURE_COUNT }, (_, index) => ({
    code: `R${String(index).padStart(CODE_DIGIT_COUNT, '0')}`, token: null,
    name: `Recent workspace ${index}`, visitedAt: Date.now() - index * VISIT_STEP_MS,
  }));
}
async function participant(settings, seed) {
  const mobile = settings.width < CASES[0].width;
  const context = await browser.newContext({ viewport: { width: settings.width, height: settings.height }, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(({ lang, theme, recents }) => {
    localStorage.setItem('rb_lang', lang); localStorage.setItem('rb_theme', theme);
    localStorage.setItem('rb_recents', JSON.stringify(recents));
  }, { ...settings, recents: seed ? fixtures() : [] });
  const page = await context.newPage(); page.setDefaultTimeout(TIMEOUT_MS);
  page.on('pageerror', error => report.errors.push(error.name));
  page.on('request', request => { if (request.method() === 'POST') report.writes++; });
  page.on('websocket', socket => { if (/^\/yjs(?:-public)?\//.test(new URL(socket.url()).pathname)) report.writes++; });
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  await page.locator('.rb-landing__input').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, context, mobile };
}
function rect(locator) { return locator.evaluate(node => node.getBoundingClientRect().toJSON()); }
async function activate(user, target) { if (user.mobile) await target.tap(); else await target.click(); }
async function dockRect(page) {
  const box = await rect(page.locator('.rb-landing__public-bar'));
  const viewportHeight = await page.evaluate(() => innerHeight);
  assert.ok(Math.abs(box.bottom - viewportHeight) <= EDGE_TOLERANCE_PX, JSON.stringify({ box, viewportHeight }));
  assert.ok(box.top >= 0); return box;
}
async function checkCue(user) {
  const cue = user.page.locator('.rb-landing__scroll-cue');
  assert.equal(await cue.getAttribute('href'), '#landing-recents');
  assert.ok((await rect(cue)).height >= TOUCH_TARGET_MIN_PX);
  await activate(user, cue);
  assert.equal(new URL(user.page.url()).hash, '', 'Section scrolling must not pin the document to a URL fragment during keyboard resize');
  const movement = await user.page.evaluate(async count => {
    const bar = document.querySelector('.rb-landing__public-bar'); let minimum = Infinity, maximum = -Infinity;
    for (let index = 0; index < count; index++) {
      await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
      const bottom = bar.getBoundingClientRect().bottom; minimum = Math.min(minimum, bottom); maximum = Math.max(maximum, bottom);
    }
    return { minimum, maximum };
  }, SCROLL_FRAME_COUNT);
  assert.ok(movement.maximum - movement.minimum <= EDGE_TOLERANCE_PX, 'Public dock must stay still during the scroll');
  await user.page.waitForFunction(() => {
    const section = document.getElementById('landing-recents').getBoundingClientRect();
    return section.top >= 0 && section.top < document.querySelector('.rb-landing__scroll').clientHeight;
  });
  return movement;
}
async function checkKeyboard(user, settings) {
  await user.page.setViewportSize({ width: settings.width, height: KEYBOARD_VIEWPORT_HEIGHT_PX });
  const measurements = [];
  for (const input of await user.page.locator('.rb-landing__input').all()) {
    await input.tap(); await input.fill('Mobile input');
    await user.page.screenshot({ path: join(output, `${settings.name}-keyboard-${measurements.length}.png`) });
    await user.page.waitForFunction(() => {
      const field = document.activeElement;
      if (!field.matches('.rb-landing__input')) return false;
      const bounds = field.getBoundingClientRect(), dock = document.querySelector('.rb-landing__public-bar').getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= dock.top;
    });
    const box = await rect(input), dock = await dockRect(user.page);
    assert.ok(box.top >= 0 && box.bottom <= dock.top, 'Focused input must remain above the dock');
    assert.ok(await input.evaluate(node => parseFloat(getComputedStyle(node).fontSize)) >= MOBILE_INPUT_MIN_FONT_PX);
    measurements.push({ box, dock });
  }
  return measurements;
}
async function checkCase(settings) {
  setLang(settings.lang); const user = await participant(settings, true);
  try {
    const rows = user.page.locator('.rb-landing__recent');
    await user.page.waitForFunction(count => document.querySelectorAll('.rb-landing__recent').length === count, RECENT_FIXTURE_COUNT);
    const before = await dockRect(user.page);
    await user.page.screenshot({ path: join(output, `${settings.name}-hero.png`) });
    const movement = await checkCue(user);
    await user.page.screenshot({ path: join(output, `${settings.name}-recents.png`) });
    await user.page.locator('.rb-landing__scroll').evaluate(node => { node.style.scrollBehavior = 'auto'; node.scrollTop = node.scrollHeight; });
    const last = await rect(rows.last()), after = await dockRect(user.page);
    assert.ok(last.bottom <= after.top && last.top >= 0, 'Last recent room must not sit behind the dock');
    assert.ok(Math.abs(before.top - after.top) <= EDGE_TOLERANCE_PX, JSON.stringify({ before, after }));
    await activate(user, rows.last().getByRole('button', { name: t('landing.recents.remove'), exact: true }));
    assert.equal(await rows.count(), RECENT_FIXTURE_COUNT - 1);
    assert.equal(await user.page.locator('.rb-public-wall__join').getAttribute('href'), '/public');
    assert.equal(await user.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const keyboard = settings.name.startsWith('phone') ? await checkKeyboard(user, settings) : [];
    report.cases.push({ ...settings, before, after, last, movement, keyboard });
    console.log(JSON.stringify({ ts: new Date().toISOString(), case: settings.name, result: 'PASS' }));
  } finally { await user.context.close(); }
}
try {
  for (const settings of CASES) await checkCase(settings);
  const user = await participant(CASES[3], false);
  try {
    setLang(CASES[3].lang); await user.page.getByText(t('landing.recents.empty'), { exact: true }).waitFor();
    await checkCue(user); assert.equal(await user.page.locator('.rb-landing__recent').count(), 0);
  } finally { await user.context.close(); }
  assert.deepEqual(report.errors, []); assert.equal(report.writes, 0, 'Landing must not open a board session or mutate a room');
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close();
}
