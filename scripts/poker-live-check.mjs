#!/usr/bin/env node
// Two-participant Planning Poker live check against isolated local servers
// (start them as in ui-live-check.mjs's header). Creates one poker room and one
// board room. Run: node scripts/poker-live-check.mjs <base-url> <SSD output>
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setLang, t } from '../src/client/ui/i18n.js';

const SSD_ROOT = '/Volumes/ssd-fluke/BaseData';
const PLAYWRIGHT_MODULE = '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const TIMEOUT_MS = 15_000;
const VIEWPORT_DESKTOP = { width: 1440, height: 900 };
const VIEWPORT_NARROW = { width: 390, height: 844 };
const POKER_URL_PATTERN = /\/p\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
const STORY_A = 'Login page';
const STORY_B = 'Checkout';
const STORY_B_RENAMED = 'Checkout with coupons';
const VOTE_A = '5';
const VOTE_B = '8';
// Average of 5 and 8 is 6.5, equally far from 5 and 8: estimates round up.
const EXPECTED_AVERAGE = '6.5';
const EXPECTED_SUGGESTION = '8';
const JSON_INDENT_SPACES = 2;

const [baseArg, outputArg] = process.argv.slice(2);
assert.ok(baseArg && outputArg, 'Pass base URL and SSD output directory');
const base = new URL(baseArg);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname), 'local servers only: this check creates rooms');
const output = resolve(outputArg);
assert.ok(output.startsWith(`${SSD_ROOT}/`), `output must be under ${SSD_ROOT}`);
assert.notEqual((await stat(SSD_ROOT)).dev, (await stat('/Volumes')).dev, 'SSD must be mounted');
await mkdir(join(output, 'browser-temp'), { recursive: true });
process.env.TMPDIR = join(output, 'browser-temp');

const playwright = await import(pathToFileURL(PLAYWRIGHT_MODULE).href);
const browser = await playwright.chromium.launch({ headless: true });
const report = { ts: new Date().toISOString(), steps: [], errors: [], screenshots: [] };

// Labels in the participant's language; t() reads the language at call time.
function label(lang, key, params) {
  setLang(lang);
  return t(key, params);
}

async function participant(lang, theme) {
  const context = await browser.newContext({ viewport: VIEWPORT_DESKTOP });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.origin });
  await context.addInitScript(({ language, colorTheme }) => {
    if (!localStorage.getItem('rb_lang')) localStorage.setItem('rb_lang', language);
    if (!localStorage.getItem('rb_theme')) localStorage.setItem('rb_theme', colorTheme);
  }, { language: lang, colorTheme: theme });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.on('pageerror', (error) => report.errors.push({ lang, message: error.message }));
  page.on('console', (message) => { if (message.type() === 'error') report.errors.push({ lang, console: message.text() }); });
  return { page, lang };
}

async function step(name, action) {
  const entry = { name, passed: false };
  report.steps.push(entry);
  try {
    entry.details = await action();
    entry.passed = true;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function screenshot(page, name) {
  const path = join(output, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  report.screenshots.push(path);
}

async function enterName({ page, lang }, name) {
  await page.getByPlaceholder(label(lang, 'name.placeholder')).fill(name);
  await page.getByRole('button', { name: label(lang, 'name.confirm'), exact: true }).click();
}

const seat = ({ page }, name) => page.locator('.rb-poker-seat').filter({ hasText: name });
const card = ({ page }, value) => page.locator('.rb-poker-hand').getByRole('button', { name: value, exact: true });
const button = ({ page, lang }, key, params) => page.getByRole('button', { name: label(lang, key, params), exact: true });

async function expectSeatCard(who, name, text) {
  const seatCard = seat(who, name).locator('.rb-poker-seat__card');
  await seatCard.waitFor();
  assert.equal((await seatCard.textContent()).trim(), text, `${who.lang}: ${name} card shows "${text}"`);
}

let alice;
let bob;
let roomUrl;
try {
  alice = await participant('en', 'light');
  bob = await participant('th', 'light');

  await step('guide page starts a poker room', async () => {
    await alice.page.goto(new URL('/planning-poker', base).href, { waitUntil: 'domcontentloaded' });
    await alice.page.getByRole('heading', { level: 1, name: label('en', 'pokerPage.heading') }).waitFor();
    await button(alice, 'landing.poker.btn').click();
    await alice.page.waitForURL(POKER_URL_PATTERN);
    roomUrl = alice.page.url();
    await enterName(alice, 'Alice');
    return { roomUrl: roomUrl.replace(/#.*/, '#<token>') };
  });

  await step('stories pasted by A appear for B', async () => {
    await alice.page.getByPlaceholder(label('en', 'poker.stories.placeholder')).fill(`${STORY_A}\n${STORY_B}`);
    await button(alice, 'poker.stories.add').click();
    await bob.page.goto(roomUrl, { waitUntil: 'domcontentloaded' });
    await enterName(bob, 'Bob');
    await bob.page.getByRole('heading', { level: 2, name: STORY_A }).waitFor();
    await bob.page.locator('.rb-poker-story').filter({ hasText: STORY_B }).waitFor();
    await seat(alice, 'Bob').waitFor();
  });

  await step('votes stay face down for the other participant', async () => {
    await card(alice, VOTE_A).click();
    await card(bob, VOTE_B).click();
    await bob.page.locator('.rb-poker-seat__card--down').waitFor();
    await alice.page.locator('.rb-poker-seat__card--down').waitFor();
    await expectSeatCard(alice, 'Bob', '');
    await expectSeatCard(bob, 'Alice', '');
    await expectSeatCard(alice, 'Alice', VOTE_A);
    await screenshot(bob.page, 'poker-voting-th-light');
  });

  await step('reveal by B flips both tables with the same result', async () => {
    await button(bob, 'poker.reveal').click();
    for (const who of [alice, bob]) {
      await expectSeatCard(who, 'Bob', VOTE_B);
      await expectSeatCard(who, 'Alice', VOTE_A);
      const average = who.page.locator('.rb-poker-summary__stats dd').first();
      await average.waitFor();
      assert.equal((await average.textContent()).trim(), EXPECTED_AVERAGE);
    }
    assert.equal(await card(alice, VOTE_A).isDisabled(), true, 'cards lock after reveal');
    await screenshot(alice.page, 'poker-revealed-en-light');
  });

  await step('accepting the suggestion and moving on syncs', async () => {
    await button(alice, 'poker.summary.accept', { value: EXPECTED_SUGGESTION }).click();
    await bob.page.locator('.rb-poker-story').filter({ hasText: STORY_A }).locator('.rb-poker-story__final').filter({ hasText: EXPECTED_SUGGESTION }).waitFor();
    await button(bob, 'poker.next').click();
    await alice.page.getByRole('heading', { level: 2, name: STORY_B }).waitFor();
  });

  await step('rename by B syncs, and undo/redo by B reverts and restores it', async () => {
    const row = bob.page.locator('.rb-poker-story').filter({ hasText: STORY_B });
    await row.getByRole('button', { name: label('th', 'poker.stories.rename') }).click();
    const editor = bob.page.getByRole('textbox', { name: label('th', 'poker.stories.title'), exact: true });
    await editor.fill(STORY_B_RENAMED);
    await editor.press('Enter');
    await alice.page.getByRole('heading', { level: 2, name: STORY_B_RENAMED }).waitFor();
    await bob.page.locator('body').click({ position: { x: 1, y: 1 } });
    await bob.page.keyboard.press('Control+z');
    await alice.page.getByRole('heading', { level: 2, name: STORY_B, exact: true }).waitFor();
    await bob.page.keyboard.press('Control+Shift+z');
    await alice.page.getByRole('heading', { level: 2, name: STORY_B_RENAMED }).waitFor();
  });

  await step('vote again clears a revealed round on both sides', async () => {
    await card(alice, '3').click();
    await button(alice, 'poker.reveal').click();
    await button(bob, 'poker.reset').click();
    await alice.page.locator('.rb-poker-seat__card--empty').nth(1).waitFor();
    assert.equal(await alice.page.locator('.rb-poker-seat__card--up, .rb-poker-seat__card--down').count(), 0);
    assert.equal(await card(alice, '3').isDisabled(), false, 'cards unlock after reset');
  });

  await step('copy link copies the poker URL', async () => {
    await button(alice, 'topbar.copyLink').click();
    assert.equal(await alice.page.evaluate(() => navigator.clipboard.readText()), roomUrl);
  });

  await step('dark theme and narrow width render', async () => {
    await alice.page.evaluate(() => localStorage.setItem('rb_theme', 'dark'));
    await alice.page.reload({ waitUntil: 'domcontentloaded' });
    await alice.page.locator('html[data-theme="dark"]').waitFor();
    await alice.page.getByRole('heading', { level: 2, name: STORY_B_RENAMED }).waitFor();
    await screenshot(alice.page, 'poker-en-dark');
    await bob.page.setViewportSize(VIEWPORT_NARROW);
    await screenshot(bob.page, 'poker-th-narrow');
    const overflow = await bob.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal scroll at ${VIEWPORT_NARROW.width}px (overflow ${overflow}px)`);
  });

  await step('a board link opened at /p/ is not turned into a poker room', async () => {
    await alice.page.goto(base.href, { waitUntil: 'domcontentloaded' });
    await button(alice, 'landing.create.btn').click();
    await alice.page.waitForURL(BOARD_URL_PATTERN);
    await enterName(alice, 'Alice');
    const pokerUrl = alice.page.url().replace('/b/', '/p/');
    await bob.page.goto(pokerUrl, { waitUntil: 'domcontentloaded' });
    await bob.page.getByText(label('th', 'poker.wrongKind.head')).waitFor();
  });
} finally {
  report.passed = report.steps.every((entry) => entry.passed) && report.errors.length === 0;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, JSON_INDENT_SPACES));
  await browser.close();
}
console.log(JSON.stringify({ passed: report.passed, steps: report.steps.map(({ name, passed }) => [name, passed]), errors: report.errors }, null, JSON_INDENT_SPACES));
process.exitCode = report.passed ? 0 : 1;
