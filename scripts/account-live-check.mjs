#!/usr/bin/env node
/**
 * Two-context live check of optional Google sign-in against the local fake Google.
 * Start isolated servers first (free ports, never production ones or the repo .env):
 *   FAKE_OIDC_PORT=4455 node scripts/fake-google-oidc.mjs
 *   VITE_YJS_PORT=1250 npx vite --host localhost --port 5190 --strictPort
 *   YJS_ALLOW_INSECURE_HTTP=true YJS_PORT=1250 YJS_ROOM_CREATE_BURST=100 YJS_ROOM_CREATES_PER_HOUR=1000 \
 *     YJS_ALLOWED_ORIGINS=http://localhost:5190,http://127.0.0.1:5190 \
 *     YJS_DB_DIR=<out>/db YJS_UPLOADS_DIR=<out>/uploads \
 *     GOOGLE_OAUTH_ENDPOINT_BASE=http://127.0.0.1:4455 \
 *     GOOGLE_OAUTH_CLIENT_ID=dev-client GOOGLE_OAUTH_CLIENT_SECRET=dev-secret \
 *     GOOGLE_OAUTH_REDIRECT_URI=http://localhost:1250/api/auth/google/callback \
 *     YJS_MAINTAINER_KEY=<random base64url key, env only> YJS_MAINTAINER_PORT=1251 \
 *     node yjs-server.mjs > <out>/relay.log 2>&1
 * YJS_MAINTAINER_KEY=<same key> YJS_MAINTAINER_PORT=1251 node scripts/account-live-check.mjs http://localhost:5190 <out>
 * Use the redirect URI's host (localhost) for the base URL so the account cookie reaches the relay.
 * GOOGLE_OAUTH_ENDPOINT_BASE must be the stub's printed URL exactly: it is also the expected issuer.
 * A (English) signs in, is granted Pro through the maintainer API, cancels, signs out everywhere and
 * deletes the account; B (Thai) stays a guest, creates a board, and both edit it with undo/redo.
 */
import assert from 'node:assert/strict';
import { FAKE_GOOGLE_PROFILE } from './fake-google-oidc.mjs';
import { BASE_LABELS, SYNC_TIMEOUT_MS, addSticky, enter, participant, runLiveCheck, shot, step } from './board-live-helpers.mjs';

const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
const APPROVE_SELECTOR = '#approve';
const CANCEL_SELECTOR = '#cancel';
const AUTH_ERROR_PARAM = 'auth_error';
const PLAN_PRO = 'pro';
const UNDO_KEY = 'ControlOrMeta+z';
const REDO_KEY = 'ControlOrMeta+Shift+z';
const UNDO_PRESS_LIMIT = 12;
const UNDO_SETTLE_TIMEOUT_MS = 2_000;
const STICKY_A_PX = { x: 480, y: 360 };
const STICKY_B_PX = { x: 960, y: 360 };
const NAME_A = 'Ada';
const NAME_B = 'บี';
const LABELS = {
  en: { signIn: 'Sign in with Google', menu: 'Account menu', free: 'Free plan', pro: 'Pro plan',
    signOutAll: 'Sign out everywhere', delete: 'Delete account', cancelled: 'Sign-in was cancelled.' },
  th: { signIn: 'เข้าสู่ระบบด้วย Google' },
};

function maintainerSettings() {
  const { YJS_MAINTAINER_KEY: key, YJS_MAINTAINER_PORT: port } = process.env;
  if (!key || !port) throw new Error('YJS_MAINTAINER_KEY and YJS_MAINTAINER_PORT must match the relay environment.');
  return { key, origin: `http://127.0.0.1:${port}` };
}

// The owner's console API: find the fake Google account by email, then set its plan.
async function grantPlan(plan) {
  const { key, origin } = maintainerSettings();
  const authorization = `Bearer ${key}`;
  const found = await fetch(`${origin}/api/accounts?email=${encodeURIComponent(FAKE_GOOGLE_PROFILE.email)}`, { headers: { authorization } });
  assert.equal(found.status, 200, 'maintainer finds the signed-in account');
  const { id } = await found.json();
  const changed = await fetch(`${origin}/api/accounts/${id}/plan`, {
    method: 'POST', headers: { authorization, origin, 'content-type': 'application/json' }, body: JSON.stringify({ plan }),
  });
  assert.equal(changed.status, 200, 'maintainer changes the plan');
  assert.equal((await changed.json()).plan, plan);
}

const sameOrigin = (baseUrl) => (url) => url.origin === new URL(baseUrl).origin;
const accountTrigger = (page) => page.getByRole('button', { name: LABELS.en.menu, exact: true });
const signInLink = (page, lang) => page.getByRole('link', { name: LABELS[lang].signIn, exact: true });

async function expectSignedIn(page, planLabel) {
  const trigger = accountTrigger(page);
  await trigger.getByText(FAKE_GOOGLE_PROFILE.name, { exact: true }).waitFor();
  await trigger.getByText(planLabel, { exact: true }).waitFor();
}

async function expectSignedOut(page) {
  await signInLink(page, 'en').waitFor();
  assert.equal(await accountTrigger(page).count(), 0, 'no account menu while signed out');
}

/** Goes through the stub's consent page and returns to the landing page. */
async function visitStub(page, baseUrl, decision) {
  await signInLink(page, 'en').click();
  await page.locator(decision).click();
  await page.waitForURL(sameOrigin(baseUrl));
}

async function openLanding(page, baseUrl) {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: BASE_LABELS.en.create, exact: true })
    .or(page.getByRole('button', { name: BASE_LABELS.th.create, exact: true })).first().waitFor();
}

async function chooseFromMenu(page, label) {
  await accountTrigger(page).click();
  await page.getByRole('button', { name: label, exact: true }).click();
}

async function undoUntilHidden(page, text) {
  for (let presses = 1; presses <= UNDO_PRESS_LIMIT; presses += 1) {
    await page.keyboard.press(UNDO_KEY);
    try {
      await page.getByText(text, { exact: true }).waitFor({ state: 'hidden', timeout: UNDO_SETTLE_TIMEOUT_MS });
      return presses;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
  }
  throw new Error(`"${text}" still shows after ${UNDO_PRESS_LIMIT} undo presses.`);
}

const waitForTextOn = (pages, text, state = 'visible') => Promise.all(
  pages.map(page => page.getByText(text, { exact: true }).waitFor({ state, timeout: SYNC_TIMEOUT_MS })),
);

// New stickies start private, so each one is revealed for the other participant.
async function addSharedSticky(page, lang, text, position) {
  await addSticky(page, lang, text, position);
  await page.getByTitle(BASE_LABELS[lang].reveal, { exact: true }).click();
}

async function accountSteps({ a, b, report, browser, baseUrl }) {
  await step(report, 'signed-out menu renders in en (A) and th (B)', async () => {
    await openLanding(a, baseUrl);
    await expectSignedOut(a);
    await shot(a, 'signed-out-en.png', report);
    await openLanding(b, baseUrl);
    await signInLink(b, 'th').waitFor();
    await shot(b, 'signed-out-th.png', report);
  });
  await step(report, 'cancel at the stub shows the access_denied toast', async () => {
    await visitStub(a, baseUrl, CANCEL_SELECTOR);
    await a.getByText(LABELS.en.cancelled, { exact: true }).waitFor({ state: 'visible' });
    await shot(a, 'access-denied-toast-en.png', report);
    assert.equal(new URL(a.url()).searchParams.has(AUTH_ERROR_PARAM), false, 'auth_error leaves the address bar');
    await expectSignedOut(a);
  });
  await step(report, 'A signs in and sees the name and Free', async () => {
    await visitStub(a, baseUrl, APPROVE_SELECTOR);
    await expectSignedIn(a, LABELS.en.free);
    await shot(a, 'signed-in-free-en.png', report);
  });
  await step(report, 'maintainer grants Pro and A sees Pro after reload', async () => {
    await grantPlan(PLAN_PRO);
    await a.reload();
    await expectSignedIn(a, LABELS.en.pro);
    await shot(a, 'pro-badge-en.png', report);
  });
  await step(report, 'A reloads and stays signed in', async () => {
    await a.reload();
    await expectSignedIn(a, LABELS.en.pro);
  });
  await step(report, 'Sign out everywhere ends A and a second A session', async () => {
    const other = await participant(browser, 'en', report, 'A2');
    try {
      await openLanding(other, baseUrl);
      await visitStub(other, baseUrl, APPROVE_SELECTOR);
      await expectSignedIn(other, LABELS.en.pro);
      await chooseFromMenu(a, LABELS.en.signOutAll);
      await expectSignedOut(a);
      await a.reload();
      await expectSignedOut(a);
      await other.reload();
      await expectSignedOut(other);
    } finally {
      await other.context().close();
    }
  });
  await step(report, 'A deletes the account; a new sign-in shows Free', async () => {
    await visitStub(a, baseUrl, APPROVE_SELECTOR);
    await expectSignedIn(a, LABELS.en.pro);
    await chooseFromMenu(a, LABELS.en.delete);
    await a.getByRole('dialog').getByRole('button', { name: LABELS.en.delete, exact: true }).click();
    await expectSignedOut(a);
    await a.reload();
    await expectSignedOut(a);
    await visitStub(a, baseUrl, APPROVE_SELECTOR);
    await expectSignedIn(a, LABELS.en.free);
  });
}

async function collaborationSteps({ a, b, report, baseUrl }) {
  await step(report, 'B stays a guest and creates a board', async () => {
    await openLanding(b, baseUrl);
    await signInLink(b, 'th').waitFor();
    await b.getByRole('button', { name: BASE_LABELS.th.create, exact: true }).click();
    await b.waitForURL(BOARD_URL_PATTERN);
    await enter(b, 'th', NAME_B);
  });
  const stamp = Date.now();
  const textA = `signed-in-A-${stamp}`;
  const textB = `guest-B-${stamp}`;
  await step(report, 'signed-in A and guest B edit the same board both ways', async () => {
    await a.goto(b.url());
    await enter(a, 'en', NAME_A);
    await addSharedSticky(a, 'en', textA, STICKY_A_PX);
    await waitForTextOn([a, b], textA);
    await addSharedSticky(b, 'th', textB, STICKY_B_PX);
    await waitForTextOn([a, b], textB);
    await shot(b, 'guest-board-th.png', report);
  });
  await step(report, 'undo and redo on A sync to B', async () => {
    const presses = await undoUntilHidden(a, textA);
    await waitForTextOn([a, b], textA, 'hidden');
    await waitForTextOn([a, b], textB);
    for (let count = 0; count < presses; count += 1) await a.keyboard.press(REDO_KEY);
    await waitForTextOn([a, b], textA);
    return { undoPresses: presses };
  });
  await step(report, 'A is still signed in after the board session', async () => {
    await openLanding(a, baseUrl);
    await expectSignedIn(a, LABELS.en.free);
  });
}

async function setupGuests(browser, baseUrl, report) {
  const a = await participant(browser, 'en', report, 'A');
  const b = await participant(browser, 'th', report, 'B');
  report.pages.push(a, b);
  return { a, b };
}

await runLiveCheck('account-live-check.mjs', async (context) => {
  await accountSteps(context);
  await collaborationSteps(context);
}, { setup: setupGuests });
