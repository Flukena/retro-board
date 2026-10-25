import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

const REPO_URL = new URL('../../', import.meta.url);
const RELAY_ENTRY_FILE = 'yjs-server.mjs';
const DOCKER_COPY_PATTERN = /^COPY\s+(.+?)\s+\.\/src\/(?:domain|server)\/\s*$/gm;
const STATIC_RELATIVE_IMPORT_PATTERN = /\bimport\s+(?:[^;]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

function copiedSourceFiles() {
  const dockerfile = readFileSync(new URL('Dockerfile.yjs', REPO_URL), 'utf8').replace(/\\\r?\n/g, ' ');
  return new Set([...dockerfile.matchAll(DOCKER_COPY_PATTERN)]
    .flatMap(([, sources]) => sources.split(/\s+/))
    .filter((source) => !source.startsWith('--')));
}

function relayLocalDependencies() {
  const reached = new Set();
  const pending = [RELAY_ENTRY_FILE];
  while (pending.length > 0) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    const source = readFileSync(new URL(file, REPO_URL), 'utf8');
    for (const [, importPath] of source.matchAll(STATIC_RELATIVE_IMPORT_PATTERN)) {
      pending.push(posix.normalize(posix.join(posix.dirname(file), importPath)));
    }
  }
  reached.delete(RELAY_ENTRY_FILE);
  return reached;
}

test('relay image copies every transitive local static import', () => {
  const copied = copiedSourceFiles();
  const missing = [...relayLocalDependencies()].filter((file) => !copied.has(file));
  assert.deepEqual(missing, [], `Relay image is missing local imports: ${missing.join(', ')}`);
});
