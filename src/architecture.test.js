import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { PROJECT_ROOT, productionSources } from '../scripts/project-files.mjs';

const RELATIVE_IMPORTS = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;
const LAYERS = ['client', 'domain', 'server'];
const SOURCES = productionSources();
const graph = new Map(SOURCES.map(file => {
  const source = readFileSync(resolve(PROJECT_ROOT, file), 'utf8');
  const imports = [...source.matchAll(RELATIVE_IMPORTS)].map(match => match[1] ?? match[2]);
  const dependencies = imports.map(path => relative(PROJECT_ROOT, resolve(PROJECT_ROOT, dirname(file), path)));
  return [file, dependencies];
}));

for (const layer of LAYERS) {
  test(`${layer} modules obey one-way runtime dependencies`, () => {
    const violations = [];
    for (const [file, dependencies] of graph) {
      if (!file.startsWith(`src/${layer}/`)) continue;
      for (const dependency of dependencies) {
        assert.ok(existsSync(resolve(PROJECT_ROOT, dependency)), `${file}: missing ${dependency}`);
        const ownLayer = dependency.startsWith(`src/${layer}/`);
        const domain = dependency.startsWith('src/domain/');
        const appEntry = file === 'src/client/app/main.jsx' && dependency === 'RetroBoard.jsx';
        if (!ownLayer && !domain && !appEntry) violations.push(`${file} -> ${dependency}`);
      }
    }
    assert.deepEqual(violations, []);
  });
}

test('domain modules remain independent of browser and Node hosts', () => {
  for (const file of SOURCES.filter(name => name.startsWith('src/domain/'))) {
    const source = readFileSync(resolve(PROJECT_ROOT, file), 'utf8');
    assert.doesNotMatch(source, /(?:from|import)\s*['"](?:node:|react(?:['"/]))/, file);
    assert.doesNotMatch(source, /\b(?:window|document|localStorage|sessionStorage|navigator)\s*\./, file);
  }
});

function visit(file, completed, active) {
  assert.ok(!active.has(file), `Import cycle: ${[...active, file].join(' -> ')}`);
  if (completed.has(file) || !graph.has(file)) return;
  active.add(file);
  for (const dependency of graph.get(file)) visit(dependency, completed, active);
  active.delete(file);
  completed.add(file);
}

test('production imports have no cycles', () => {
  const completed = new Set();
  for (const file of graph.keys()) visit(file, completed, new Set());
});
