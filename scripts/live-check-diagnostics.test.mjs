import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatLiveReport, redactRoomCapabilities } from './live-check-diagnostics.mjs';

const ROOM = 'https://example.invalid/b/review';
const TOKEN = 'synthetic-only_room-token';
const INVITE = `${ROOM}#${TOKEN}`;
const GUIDE = 'https://example.invalid/guide#voting';

test('a report preserves diagnostic context and keeps the join URL available in memory', () => {
  const report = {
    steps: [{ name: 'join', passed: true, details: { boardUrl: INVITE } }],
    errors: [{ stack: `reopen "${INVITE}"\nsee ${GUIDE}` }],
  };
  const saved = JSON.parse(formatLiveReport(report));
  assert.deepEqual(saved.steps, [{ name: 'join', passed: true, details: { boardUrl: ROOM } }]);
  assert.deepEqual(saved.errors, [{ stack: `reopen "${ROOM}"\nsee ${GUIDE}` }]);
  assert.equal(report.steps[0].details.boardUrl, INVITE);
});

test('captured text strips board and poker capabilities while preserving other URL fragments and prose', () => {
  const poker = '/p/abc/?view=cards';
  const message = `Retry (${INVITE}), then ${poker}#${TOKEN}. See ${GUIDE} #help`;
  assert.equal(redactRoomCapabilities(message), `Retry (${ROOM}), then ${poker}. See ${GUIDE} #help`);
});

test('the standalone UI checker redacts room links from its error output', () => {
  const cli = fileURLToPath(new URL('./ui-live-check.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, INVITE], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`Invalid argument: ${ROOM}`));
  assert.ok(!result.stderr.includes(TOKEN));
});
