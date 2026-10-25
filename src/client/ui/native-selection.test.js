import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('native selection policy loads before every app route and leaves scrolling, fine pointers and editable fields native', () => {
  const css = readFileSync(new URL('./native-selection.css', import.meta.url), 'utf8');
  const bootstrap = readFileSync(new URL('../app/main.jsx', import.meta.url), 'utf8');
  assert.match(bootstrap, /import '\.\.\/ui\/native-selection\.css'/);
  assert.match(css, /^@media \(pointer: coarse\)/);
  assert.match(css, /#root\s*\{[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;[^}]*-webkit-touch-callout:\s*none;/);
  assert.match(css, /:is\(input, textarea, \[contenteditable="true"\]/);
  assert.match(css, /-webkit-user-select:\s*text;[^}]*user-select:\s*text;[^}]*-webkit-touch-callout:\s*default;/);
  assert.doesNotMatch(css, /#root\s+\*/);
  assert.doesNotMatch(css, /!important|touch-action|pointer-events|::selection/);
});
