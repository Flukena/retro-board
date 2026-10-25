import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesUnder, projectTests, productionSources } from './project-files.mjs';

test('nested tests and source files remain discoverable after feature relocation', t => {
  const root = mkdtempSync(join(tmpdir(), 'retro-discovery-'));
  t.after(() => rmSync(root, { recursive: true }));
  for (const directory of ['src/client/board', 'src/server', 'scripts']) mkdirSync(join(root, directory), { recursive: true });
  const files = ['relay.test.mjs', 'src/client/board/Card.jsx', 'src/client/board/Card.test.js',
    'src/server/session.test.mjs', 'scripts/check.test.mjs'];
  for (const file of files) writeFileSync(join(root, file), '');
  assert.deepEqual(projectTests(root), ['relay.test.mjs', 'scripts/check.test.mjs',
    'src/client/board/Card.test.js', 'src/server/session.test.mjs']);
  assert.deepEqual(productionSources(root), ['RetroBoard.jsx', 'yjs-server.mjs', 'src/client/board/Card.jsx']);
  assert.equal(filesUnder('src', root).length, 3);
});
