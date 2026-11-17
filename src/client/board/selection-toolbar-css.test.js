import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOKENS } from '../ui/theme.js';
import { contrastRatio, parseColor } from '../ui/color-contrast.js';
import { MIN_NORMAL_TEXT_CONTRAST_RATIO } from '../../test-support/contrast.js';

const FULLY_OPAQUE_ALPHA = 1;

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

function resolveToken(value, tokens) {
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference ? resolveToken(tokens[reference[1]], tokens) : value;
}

test('selection toolbar paints an opaque surface so cards beneath never show through its icons', () => {
  const css = readFileSync(new URL('./selection-toolbar.css', import.meta.url), 'utf8');
  const rule = css.match(/\.rb-surface\.rb-selection-toolbar\s*\{([^}]+)\}/)[1];
  const declared = Object.fromEntries([...rule.matchAll(/([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  assert.equal(declared['box-shadow'], 'var(--shadow-pop)');
  for (const [mode, tokens] of Object.entries(TOKENS)) {
    const surface = parseColor(resolveToken(declared.background, tokens));
    assert.equal(surface.a, FULLY_OPAQUE_ALPHA, `${mode} toolbar surface must be opaque`);
    assert.equal(resolveToken(declared['border-color'], tokens), tokens['--border']);
    const ratio = contrastRatio(parseColor(resolveToken(declared.color, tokens)), surface);
    assert.ok(ratio >= MIN_NORMAL_TEXT_CONTRAST_RATIO, `${mode} toolbar text contrast ${ratio} is too low`);
  }
});
