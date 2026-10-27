// Writes the pre-rendered public pages into dist/ after `vite build` and the
// SSR build of src/client/seo/prerender-entry.jsx into .prerender/.
// Usage: node scripts/prerender-pages.mjs [distDir] [ssrDir]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const distDir = resolve(process.argv[2] || 'dist');
const ssrDir = resolve(process.argv[3] || '.prerender');
const { prerenderedPages } = await import(pathToFileURL(join(ssrDir, 'prerender-entry.js')).href);
const { pageDocument } = await import(pathToFileURL(resolve('src/client/seo/page-document.js')).href);

const template = readFileSync(join(distDir, 'index.html'), 'utf8');
for (const { file, options } of prerenderedPages()) {
  const target = join(distDir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pageDocument(template, options));
  console.log(`prerendered ${file}`);
}
rmSync(ssrDir, { recursive: true, force: true });
