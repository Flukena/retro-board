import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

const REPO_URL = new URL('../../', import.meta.url);
const RELAY_ENTRY_FILE = 'yjs-server.mjs';
const DOCKER_COPY_PATTERN = /^COPY\s+(.+?)\s+\.\/src\/(?:domain|server)\/\s*$/gm;
const STATIC_RELATIVE_IMPORT_PATTERN = /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

function copiedSourceFiles() {
  const dockerfile = readFileSync(new URL('Dockerfile.yjs', REPO_URL), 'utf8').replace(/\\\r?\n/g, ' ');
  return new Set([...dockerfile.matchAll(DOCKER_COPY_PATTERN)]
    .flatMap(([, sources]) => sources.split(/\s+/))
    .filter((source) => !source.startsWith('--')));
}

function relayLocalDependencies(entry = RELAY_ENTRY_FILE, readSource = file => readFileSync(new URL(file, REPO_URL), 'utf8')) {
  const reached = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    const source = readSource(file);
    for (const [, importPath] of source.matchAll(STATIC_RELATIVE_IMPORT_PATTERN)) {
      pending.push(posix.normalize(posix.join(posix.dirname(file), importPath)));
    }
  }
  reached.delete(entry);
  return reached;
}

test('relay image copies every transitive local static import', () => {
  const copied = copiedSourceFiles();
  const missing = [...relayLocalDependencies()].filter((file) => !copied.has(file));
  assert.deepEqual(missing, [], `Relay image is missing local imports: ${missing.join(', ')}`);
});

test('image closure follows a dependency reachable only through a re-export', () => {
  const sources = new Map([
    ['entry.js', "export { X } from './only-reexported.js';"],
    ['only-reexported.js', "export * from './leaf.js';"],
    ['leaf.js', 'export const X = 1;'],
  ]);
  assert.deepEqual([...relayLocalDependencies('entry.js', file => sources.get(file))].sort(), ['leaf.js', 'only-reexported.js']);
});
