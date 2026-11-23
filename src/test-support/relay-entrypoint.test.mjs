import assert from 'node:assert/strict';
import test from 'node:test';
import { relayEntrypoint } from './relay-entrypoint.js';

test('relay fixtures share one process slot until their test has finished', async (t) => {
  await t.test('a second fixture cannot replace the active persistence', async (child) => {
    await relayEntrypoint(child);
    await assert.rejects(relayEntrypoint(child), /relay entrypoint already active/);
  });
  await t.test('the next test can use its own persistence', async (child) => {
    const relay = await relayEntrypoint(child);
    assert.ok(relay.runtimePersistence);
  });
});
