import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('selection and group toolbar anchoring composes with rb-pop scale', () => {
  const css = readFileSync(new URL('./selection-toolbar.css', import.meta.url), 'utf8');
  const rule = css.match(/\.rb-selection-toolbar\s*\{([^}]+)\}/)[1];
  assert.match(rule, /translate:\s*-50% -100%\s*;/);
  assert.doesNotMatch(rule, /(?:^|;)\s*transform\s*:/);
});

test('font color popover translation also composes with rb-pop scale', () => {
  const css = readFileSync(new URL('./selection-toolbar.css', import.meta.url), 'utf8');
  const rule = css.match(/\.rb-font-color-picker\s*\{([^}]+)\}/)[1];
  assert.match(rule, /translate:\s*-50% 0\s*;/);
  assert.doesNotMatch(rule, /(?:^|;)\s*transform\s*:/);
});
