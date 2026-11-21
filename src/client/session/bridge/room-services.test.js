import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage } from '../../../test-support/bridge-harness.js';

const TIMER_DURATION_MINUTES = 1;

test('board-only services stay outside undo and stop accepting reactions after document destruction', async () => {
  await withStorage((browser) => {
    assert.ok(browser.storage.boardReactions);
    assert.equal(browser.storage.boardReactions.send('👏'), true);
    assert.equal(browser.storage.writingTimer.start(TIMER_DURATION_MINUTES), true);
    assert.equal(browser.storage.canUndo(), false);
    browser.__rbYDoc.destroy();
    assert.equal(browser.storage.boardReactions.send('👏'), false);
  });
});
