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
 * Signed-in A's name dialog starts with the Google name; guest B's starts with a Guest-#### name.
 */
import assert from 'node:assert/strict';
import { FAKE_GOOGLE_PROFILE } from './fake-google-oidc.mjs';
import {
  BASE_LABELS, FAKE_GOOGLE_DECISION, REDO_KEY, SYNC_TIMEOUT_MS, addSharedSticky, enter, openLanding, participant, runLiveCheck,
  shot, signInLink, step, undoUntilHidden, visitStub, waitForTextOn,
} from './board-live-helpers.mjs';

const BOARD_URL_PATTERN = /\/b\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
const { APPROVE: APPROVE_SELECTOR, CANCEL: CANCEL_SELECTOR } = FAKE_GOOGLE_DECISION;
const AUTH_ERROR_PARAM = 'auth_error';
const PLAN_PRO = 'pro';
const STICKY_A_PX = { x: 480, y: 360 };
const STICKY_B_PX = { x: 960, y: 360 };
const NAME_A = 'Ada';
const GUEST_NAME_PATTERN = /^Guest-\d{4}$/;
const PREFILL_POLL_MS = 100;
const NAME_B = 'บี';
const LABELS = {
  en: { menu: 'Account menu', free: 'Free plan', pro: 'Pro plan',
    signOutAll: 'Sign out everywhere', delete: 'Delete account', cancelled: 'Sign-in was cancelled.' },
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
  const { accounts: [{ id }] } = await found.json();
  const changed = await fetch(`${origin}/api/accounts/${id}/plan`, {
    method: 'POST', headers: { authorization, origin, 'content-type': 'application/json' }, body: JSON.stringify({ plan }),
  });
  assert.equal(changed.status, 200, 'maintainer changes the plan');
  assert.equal((await changed.json()).plan, plan);
}

const namePrompt = (page, lang) => page.getByPlaceholder(BASE_LABELS[lang].namePlaceholder, { exact: true });

// The first-visit name dialog offers the Google name once the account check returns.
async function waitForNameDraft(page, lang, matches) {
  const prompt = namePrompt(page, lang);
  await prompt.waitFor();
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let value = await prompt.inputValue();
  while (!matches(value) && Date.now() < deadline) {
    await page.waitForTimeout(PREFILL_POLL_MS);
    value = await prompt.inputValue();
  }
  assert.ok(matches(value), `unexpected name draft: ${value}`);
  return value;
}
const accountTrigger = (page) => page.getByRole('button', { name: LABELS.en.menu, exact: true });

async function expectSignedIn(page, planLabel) {
  const trigger = accountTrigger(page);
  await trigger.getByText(FAKE_GOOGLE_PROFILE.name, { exact: true }).waitFor();
  await trigger.getByText(planLabel, { exact: true }).waitFor();
}

async function expectSignedOut(page) {
  await signInLink(page, 'en').waitFor();
  assert.equal(await accountTrigger(page).count(), 0, 'no account menu while signed out');
}

async function chooseFromMenu(page, label) {
  await accountTrigger(page).click();
  await page.getByRole('button', { name: label, exact: true }).click();
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
    const guestDraft = await waitForNameDraft(b, 'th', (value) => GUEST_NAME_PATTERN.test(value));
    await enter(b, 'th', NAME_B);
    return { guestDraft };
  });
  const stamp = Date.now();
  const textA = `signed-in-A-${stamp}`;
  const textB = `guest-B-${stamp}`;
  await step(report, 'signed-in A and guest B edit the same board both ways', async () => {
    await a.goto(b.url());
    await waitForNameDraft(a, 'en', (value) => value === FAKE_GOOGLE_PROFILE.name);
    await shot(a, 'name-prefill-en.png', report);
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
