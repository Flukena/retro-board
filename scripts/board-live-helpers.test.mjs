import test from 'node:test';
import assert from 'node:assert/strict';
import { relative } from 'node:path';
import {
  DATA_VOLUME_ROOTS, boxCenter, consoleStep, dragBy, errorsStep, isExpectedBoardConsoleError, prepareDataVolumeOutput, withinPx, workspaceHeadingName,
} from './board-live-helpers.mjs';

/** A stand-in for Playwright's `page.mouse` that records calls; `failOnMove` makes that move call throw. */
function fakePage({ failOnMove = 0 } = {}) {
  const calls = { move: 0, down: 0, up: 0 };
  const mouse = {
    async move() {
      calls.move += 1;
      if (calls.move === failOnMove) throw new Error('move failed');
    },
    async down() { calls.down += 1; },
    async up() { calls.up += 1; },
  };
  return { page: { mouse }, calls };
}

const FROM = Object.freeze({ x: 100, y: 200 });
const BY = Object.freeze({ x: 40, y: -30 });
const STEPPED_MOVE_CALL = 2;

test('live-check output is limited to the two data volumes', () => {
  assert.deepEqual(DATA_VOLUME_ROOTS, ['/Volumes/ssd-fluke/BaseData', '/Volumes/BaseDisk/Base']);
});

test('live-check output outside the data volumes is refused before anything is created', async () => {
  // A relative path is resolved against the working directory, which may itself be on a data volume.
  const relativeOutside = relative(process.cwd(), '/tmp/account-live-relative');
  for (const out of ['/tmp/account-live', relativeOutside, '/Volumes/BaseDisk/Base/../escape', '/Volumes/ssd-fluke/BaseDataX/run']) {
    await assert.rejects(prepareDataVolumeOutput(out), /must be under/, out);
  }
});

test('the workspace heading is found in Thai and English, with or without its room count', () => {
  const name = workspaceHeadingName();
  for (const heading of ['My boards', 'My boards 3', 'บอร์ดของฉัน', 'บอร์ดของฉัน 12']) assert.match(heading, name, heading);
  for (const other of ['My boards list', 'My boards 3 4', 'Boards', 'my boards']) assert.doesNotMatch(other, name, other);
});

test('boxCenter returns the middle of a box', () => {
  assert.deepEqual(boxCenter({ x: 10, y: 20, width: 100, height: 40 }), { x: 60, y: 40 });
});

test('withinPx accepts the boundary and rejects one pixel beyond', () => {
  assert.equal(withinPx(105, 100, 5), true);
  assert.equal(withinPx(95, 100, 5), true);
  assert.equal(withinPx(106, 100, 5), false);
  assert.equal(withinPx(94, 100, 5), false);
});

test('dragBy releases the button when a move throws', async () => {
  const { page, calls } = fakePage({ failOnMove: STEPPED_MOVE_CALL });
  await assert.rejects(dragBy(page, FROM, BY), /move failed/);
  assert.deepEqual(calls, { move: STEPPED_MOVE_CALL, down: 1, up: 1 });
});

test('dragBy with hold leaves the button down', async () => {
  const { page, calls } = fakePage();
  await dragBy(page, FROM, BY, { hold: true });
  assert.deepEqual(calls, { move: STEPPED_MOVE_CALL, down: 1, up: 0 });
});

test('dragBy with hold still releases the button when its move throws', async () => {
  const { page, calls } = fakePage({ failOnMove: STEPPED_MOVE_CALL });
  await assert.rejects(dragBy(page, FROM, BY, { hold: true }), /move failed/);
  assert.equal(calls.up, 1);
});

test('a console step preserves its result, records only success and rethrows the original failure', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const passed = [];
  const error = new Error('peer disconnected');
  assert.equal(await consoleStep('join', async () => 'joined', passed), 'joined');
  await assert.rejects(consoleStep('edit', async () => { throw error; }, passed), (caught) => caught === error);
  assert.deepEqual(passed, ['join']);
  assert.deepEqual(log.mock.calls.map(({ arguments: args }) => args), [['PASS join'], ['FAIL edit']]);
});

const TEST_ORIGIN = 'http://127.0.0.1:5301';
const resourceError = (path, status) => ({
  url: new URL(path, TEST_ORIGIN).href, text: `Failed to load resource: the server responded with a status of ${status}`,
});

function checkBrowserErrors(mode, consoleErrors, pageErrors = []) {
  const report = { baseUrl: TEST_ORIGIN, pages: [], steps: [], pageErrors, consoleErrors };
  return errorsStep({ report }, mode);
}

test('the final browser step accepts only expected resource errors for this fixture', async () => {
  const disabled = resourceError('/api/account', '404 (Not Found)');
  const signedOut = resourceError('/api/account', '401 (Unauthorized)');
  const locked = resourceError('/api/room-session', '409 (Conflict)');
  await checkBrowserErrors('plain', [disabled]);
  await checkBrowserErrors('locked', [signedOut, locked]);
  for (const error of [
    signedOut, locked, resourceError('/api/other', '404 (Not Found)'),
    resourceError('https://other.example/api/account', '404 (Not Found)'),
    resourceError('/yjs-public/api/snapshot', '502 (Bad Gateway)'), { text: 'render failed', url: '' },
    { ...disabled, text: 'Application error 404' },
  ]) await assert.rejects(checkBrowserErrors('plain', [error]), /unexpected console error/);
  await assert.rejects(checkBrowserErrors('locked', [disabled]), /unexpected console error/);
  await assert.rejects(checkBrowserErrors('plain', [], ['broken render']), /broken render/);
});

test('the manifest checks the private relay port independently of the Vite port', () => {
  const relay = 'http://127.0.0.1:1301';
  const disabledAccount = resourceError(new URL('/api/account', relay), '404 (Not Found)');
  assert.equal(isExpectedBoardConsoleError(disabledAccount, TEST_ORIGIN, 'plain', relay), true);
  assert.equal(isExpectedBoardConsoleError({ ...disabledAccount, url: TEST_ORIGIN + '/api/account' }, TEST_ORIGIN, 'plain', relay), false);
});
