import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nginx = readFileSync(new URL('../../../nginx.conf', import.meta.url), 'utf8');
const locationBody = (pattern) => {
  const match = nginx.match(new RegExp(`location ${pattern} \\{([^}]*)\\}`));
  assert.ok(match, `missing location ${pattern}`);
  return match[1];
};

test('unknown paths get a real 404 page instead of the home page', () => {
  assert.doesNotMatch(nginx, /try_files[^;]*\s\/index\.html;/, 'no catch-all fallback to the home page');
  assert.match(nginx, /error_page 404 \/404\.html;/);
  assert.match(locationBody('@page'), /try_files \$uri\/index\.html =404;/);
});

test('boards and the Public Wall are served the noindex app shell', () => {
  assert.match(locationBody('~ "\\^/b/\\[A-Za-z0-9_-\\]\\{3,32\\}/\\?\\$"'), /try_files \/app\.html =404;/);
  assert.match(locationBody('~ "\\^/p/\\[A-Za-z0-9_-\\]\\{3,32\\}/\\?\\$"'), /try_files \/app\.html =404;/);
  assert.match(locationBody('~ \\^/public/\\?\\$'), /try_files \/app\.html =404;/);
});

test('no location adds its own headers, so every response keeps the server security headers', () => {
  const locations = [...nginx.matchAll(/location [^{]+\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(locations.length > 0);
  for (const body of locations) assert.doesNotMatch(body, /add_header/);
});

test('the unhashed head script is cached for an hour with expires only, never its own headers', () => {
  const body = locationBody('= /home-hint\\.js');
  assert.match(body, /^\s*expires 1h;\s*$/m);
  assert.doesNotMatch(body, /add_header/);
});

test('every HTML file, however it is reached, is served with revalidation', () => {
  assert.match(locationBody('~ \\\\\\.html\\$'), /expires -1;/);
});
