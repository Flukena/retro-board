import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const TEST_FILE_PATTERN = /\.test\.(?:js|mjs)$/;
const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs'];

export function filesUnder(directory, root = PROJECT_ROOT) {
  const absolute = resolve(root, directory);
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, resolve(entry.parentPath, entry.name)))
    .sort();
}

export function projectTests(root = PROJECT_ROOT) {
  const rootTests = readdirSync(root).filter(name => TEST_FILE_PATTERN.test(name));
  return [...rootTests, ...filesUnder('src', root), ...filesUnder('scripts', root)]
    .filter(name => TEST_FILE_PATTERN.test(name)).sort();
}

export function productionSources(root = PROJECT_ROOT) {
  return ['RetroBoard.jsx', 'yjs-server.mjs', ...filesUnder('src', root)]
    .filter(name => SOURCE_EXTENSIONS.some(extension => name.endsWith(extension)))
    .filter(name => !TEST_FILE_PATTERN.test(name) && !name.startsWith('src/test-support/'));
}
