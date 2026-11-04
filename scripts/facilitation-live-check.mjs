#!/usr/bin/env node
/**
 * Two-participant live check for presenter follow and meeting phases (facilitation plan items 4-6).
 * Start isolated servers first (see ui-live-check.mjs for the env; pick free ports), then:
 * node scripts/facilitation-live-check.mjs <base-url> <BaseData output directory>
 * A (English, admin) presents, runs the phases and a mood check; B (Thai) follows, answers and sees the result.
 * Writes screenshots, the ZIP backup and report.json.
 */
import { BASE_LABELS, CANVAS_SELECTOR, SYNC_TIMEOUT_MS, addSticky, addZone, download, openMenu, runLiveCheck, shot, step } from './board-live-helpers.mjs';

const PRESENTER_NAME = 'Ada';
const STICKY_TEXT = 'Presenter card';
const STICKY_POSITION_PX = { x: 520, y: 380 };
const PRESENTER_PAN_PX = { x: 400, y: 250 };
const VIEWER_PAN_PX = 2500;
const POSITION_TOLERANCE_PX = 4;
const POLL_INTERVAL_MS = 250;
const EMPTY_CANVAS_PX = { x: 1100, y: 700 };
const DRAG_STEPS = 10;
const ZONE_TITLE = 'Went well';
const ZONE_DRAG_PX = { from: { x: 300, y: 560 }, to: { x: 900, y: 860 } };
const PHASE_STEPS = [
  { en: 'Write', th: 'เขียน' }, { en: 'Reveal', th: 'เปิดเผย', shortcut: 'Reveal 1 zones' },
  { en: 'Group', th: 'จัดกลุ่ม' }, { en: 'Vote', th: 'โหวต', shortcut: 'Start a vote' },
  { en: 'Discuss', th: 'คุย', shortcut: 'Lock editing' }, { en: 'Action items', th: 'Action items', shortcut: 'Open action items' },
];
const LABELS = {
  en: { start: 'Start presenting', stop: 'Stop presenting', presenting: 'You are presenting — everyone follows your view',
    phaseStart: 'Start meeting phases', next: 'Next phase', finish: 'Finish' },
  th: { following: `กำลังดูตามผู้นำเสนอ ${PRESENTER_NAME}`, invite: `${PRESENTER_NAME} กำลังนำเสนอ`, rejoin: 'กลับไปดูตาม' },
};
const MOOD = {
  en: { start: 'Start mood check', close: 'Close mood check', question: 'How are you feeling right now?', great: 'Great',
    answered: (n) => `${n} answered`, result: 'Team mood', average: 'Average 4.5 / 5',
    summary: ['## Team mood', '- 🙂 Good: 1', '- 😄 Great: 1', 'Average 4.5 / 5 from 2 people'],
    copySummary: 'Copy retro summary', exportZip: 'Export', import: 'Import', importOk: 'Overwrite',
    editingLocked: 'Editing locked' },
  th: { question: 'ตอนนี้รู้สึกอย่างไรบ้าง?', skip: 'ข้ามไปก่อน', answer: 'ตอบ', good: 'ดี',
    answered: (n) => `ตอบแล้ว ${n} คน`, result: 'ความรู้สึกของทีม', average: 'ค่าเฉลี่ย 4.5 / 5' },
};

const visible = (page, text) => page.getByText(text, { exact: true }).waitFor({ timeout: SYNC_TIMEOUT_MS });
const hidden = (page, text) => page.getByText(text, { exact: true }).waitFor({ state: 'hidden', timeout: SYNC_TIMEOUT_MS });

/** Waits until the card sits at the same screen spot for both people (B's view follows A's). */
async function sameView(a, b) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const [boxA, boxB] = await Promise.all([a, b].map(page => page.getByText(STICKY_TEXT, { exact: true }).boundingBox()));
    last = { a: boxA, b: boxB };
    if (boxA && boxB && Math.abs(boxA.x - boxB.x) <= POSITION_TOLERANCE_PX && Math.abs(boxA.y - boxB.y) <= POSITION_TOLERANCE_PX) return last;
    await a.waitForTimeout(POLL_INTERVAL_MS);
  }
  throw new Error(`views differ: ${JSON.stringify(last)}`);
}

const TIMER_SETUP_SELECTOR = '.rb-timer-setup__row';
const CURRENT_STEP = '[aria-current="step"]';
const currentStepIs = (page, label) => page.locator(CURRENT_STEP).filter({ hasText: label }).waitFor({ timeout: SYNC_TIMEOUT_MS });
// Phase buttons are looked up inside the bar: the top bar has its own "Lock editing".
const button = (page, label) => page.getByRole('status', { name: 'Meeting phases', exact: true })
  .getByRole('button', { name: label, exact: true });

/** The A-side check each phase shortcut is expected to produce. */
const SHORTCUT_EFFECT = {
  Reveal: async (a) => {
    await button(a, PHASE_STEPS[1].shortcut).waitFor({ state: 'hidden', timeout: SYNC_TIMEOUT_MS });
    await a.keyboard.press('ControlOrMeta+z'); // the reveal is undoable; the phase is not
    await button(a, PHASE_STEPS[1].shortcut).waitFor({ timeout: SYNC_TIMEOUT_MS });
    await currentStepIs(a, PHASE_STEPS[1].en);
  },
  Vote: async (a) => {
    await a.locator(TIMER_SETUP_SELECTOR).first().waitFor({ timeout: SYNC_TIMEOUT_MS });
    await a.keyboard.press('Escape');
  },
  Discuss: (a) => button(a, PHASE_STEPS[4].shortcut).waitFor({ state: 'hidden', timeout: SYNC_TIMEOUT_MS }),
  'Action items': async (a) => {
    await a.getByRole('dialog').waitFor({ timeout: SYNC_TIMEOUT_MS });
    await a.keyboard.press('Escape');
  },
};

async function dragCanvas(page, by) {
  const start = EMPTY_CANVAS_PX;
  await page.keyboard.down('Space');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + by.x, start.y + by.y, { steps: DRAG_STEPS });
  await page.mouse.up();
  await page.keyboard.up('Space');
}

await runLiveCheck('facilitation-live-check.mjs', async ({ a, b, report }) => {
  await step(report, 'A starts presenting; B follows automatically', async () => {
    await addSticky(a, 'en', STICKY_TEXT, STICKY_POSITION_PX);
    await a.getByTitle(BASE_LABELS.en.reveal, { exact: true }).click(); // new stickies start private
    await openMenu(a, 'en', LABELS.en.start);
    await Promise.all([visible(a, LABELS.en.presenting), visible(b, LABELS.th.following)]);
    await shot(a, 'presenter-en.png', report);
    await shot(b, 'follower-th.png', report);
  });
  await step(report, 'A pans; B sees the same view', async () => {
    await dragCanvas(a, PRESENTER_PAN_PX);
    return sameView(a, b);
  });
  await step(report, 'B pans away, is invited back, and rejoins', async () => {
    await b.mouse.move(EMPTY_CANVAS_PX.x, EMPTY_CANVAS_PX.y);
    await b.mouse.wheel(VIEWER_PAN_PX, VIEWER_PAN_PX);
    await Promise.all([visible(b, LABELS.th.invite), hidden(b, LABELS.th.following)]);
    await shot(b, 'invite-th.png', report);
    await b.getByRole('button', { name: LABELS.th.rejoin, exact: true }).click();
    await visible(b, LABELS.th.following);
    return sameView(a, b);
  });
  await step(report, 'Undo on A does not end the presentation', async () => {
    await a.locator(CANVAS_SELECTOR).click({ position: EMPTY_CANVAS_PX });
    await a.keyboard.press('ControlOrMeta+z');
    await a.getByText(STICKY_TEXT, { exact: true }).waitFor({ state: 'hidden', timeout: SYNC_TIMEOUT_MS });
    await visible(a, LABELS.en.presenting);
    await visible(b, LABELS.th.following);
  });
  await step(report, 'A stops presenting; both banners go away', async () => {
    await a.getByRole('button', { name: LABELS.en.stop, exact: true }).click();
    await Promise.all([hidden(a, LABELS.en.presenting), hidden(b, LABELS.th.following), hidden(b, LABELS.th.invite)]);
    await shot(b, 'after-stop-th.png', report);
  });
  await step(report, 'A starts meeting phases; B sees Write in Thai', async () => {
    await addZone(a, ZONE_TITLE, ZONE_DRAG_PX);
    await openMenu(a, 'en', LABELS.en.phaseStart);
    const picker = a.getByRole('dialog');
    await picker.waitFor({ timeout: SYNC_TIMEOUT_MS });
    await shot(a, 'phase-zone-picker-en.png', report);
    await picker.getByRole('button', { name: new RegExp(ZONE_TITLE) }).click();
    await Promise.all([currentStepIs(a, PHASE_STEPS[0].en), currentStepIs(b, PHASE_STEPS[0].th)]);
    await Promise.all([a, b].map((page) => page.locator('.rb-phase-zone', { hasText: ZONE_TITLE })
      .waitFor({ timeout: SYNC_TIMEOUT_MS })));
    await shot(a, 'phase-write-en.png', report);
    await shot(b, 'phase-write-th.png', report);
  });
  for (const phase of PHASE_STEPS.slice(1)) {
    await step(report, `A moves to ${phase.en}${phase.shortcut ? ` and runs "${phase.shortcut}"` : ''}; B follows`, async () => {
      await button(a, LABELS.en.next).click();
      await Promise.all([currentStepIs(a, phase.en), currentStepIs(b, phase.th)]);
      if (!phase.shortcut) return;
      await button(a, phase.shortcut).click();
      await SHORTCUT_EFFECT[phase.en](a);
    });
  }
  await step(report, 'Finish ends the phases on both screens', async () => {
    await shot(b, 'phase-actions-th.png', report);
    await button(a, LABELS.en.finish).click();
    await Promise.all([a, b].map(page => page.locator(CURRENT_STEP).waitFor({ state: 'hidden', timeout: SYNC_TIMEOUT_MS })));
  });
  await step(report, 'A opens a mood check; both are asked; A answers and B skips', async () => {
    // Discuss locked editing, and a lock also blocks undo for B; unlock as a facilitator would.
    await a.getByTitle(MOOD.en.editingLocked, { exact: true }).click();
    await openMenu(a, 'en', MOOD.en.start);
    await Promise.all([visible(a, MOOD.en.question), visible(b, MOOD.th.question)]);
    await shot(b, 'mood-dialog-th.png', report);
    await a.getByRole('button', { name: MOOD.en.great, exact: true }).click();
    await b.getByRole('button', { name: MOOD.th.skip, exact: true }).click();
    await Promise.all([visible(a, MOOD.en.answered(1)), visible(b, MOOD.th.answered(1)), hidden(b, MOOD.th.question)]);
  });
  await step(report, 'B answers from the banner; undo removes only B\'s answer; B answers again', async () => {
    await b.getByRole('button', { name: MOOD.th.answer, exact: true }).click();
    await b.getByRole('button', { name: MOOD.th.good, exact: true }).click();
    await visible(a, MOOD.en.answered(2));
    await b.locator(CANVAS_SELECTOR).click({ position: EMPTY_CANVAS_PX });
    await b.keyboard.press('ControlOrMeta+z');
    await Promise.all([visible(a, MOOD.en.answered(1)), visible(b, MOOD.th.question)]);
    await b.getByRole('button', { name: MOOD.th.good, exact: true }).click();
    await Promise.all([visible(a, MOOD.en.answered(2)), visible(b, MOOD.th.answered(2))]);
  });
  await step(report, 'A closes the round; both see the same anonymous result', async () => {
    await a.getByRole('status').getByRole('button', { name: MOOD.en.close, exact: true }).click();
    await Promise.all([visible(a, MOOD.en.result), visible(b, MOOD.th.result), visible(a, MOOD.en.average), visible(b, MOOD.th.average)]);
    await shot(a, 'mood-result-en.png', report);
    await shot(b, 'mood-result-th.png', report);
  });
  await step(report, 'The copied summary has the Mood section', async () => {
    await openMenu(a, 'en', MOOD.en.copySummary);
    const text = await a.evaluate(() => navigator.clipboard.readText());
    const missing = MOOD.en.summary.filter((line) => !text.split('\n').includes(line));
    if (missing.length) throw new Error(`summary missing ${JSON.stringify(missing)}`);
    return { summaryLines: MOOD.en.summary };
  });
  await step(report, 'ZIP export then import keeps the round and its answers', async () => {
    const zip = await download(a, 'en', MOOD.en.exportZip, report);
    const chooser = a.waitForEvent('filechooser');
    await openMenu(a, 'en', MOOD.en.import);
    await (await chooser).setFiles(zip);
    await a.getByRole('button', { name: MOOD.en.importOk, exact: true }).click();
    await Promise.all([visible(a, MOOD.en.average), visible(b, MOOD.th.average), visible(b, MOOD.th.answered(2))]);
  });
});
