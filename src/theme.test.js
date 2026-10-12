import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { defineTokens, TOKENS } from './theme.js';
import { compositeOver, contrastRatio } from './color-contrast.js';

const MIN_NORMAL_TEXT_CONTRAST_RATIO = 4.5; // WCAG 2.2 SC 1.4.3.
const COMPONENT_LOCAL_TOKEN_PREFIX = '--rb-';
const TOKEN_REFERENCE_PATTERN = /var\(\s*(--[\w-]+)/g;
const TEXT_BACKGROUND_PAIRS = [
  ['--brand-tile-fg', '--brand-tile-bg'],
  ['--text', '--bg'],
  ['--text', '--bg-panel'],
  ['--text-mid', '--bg-panel-2'],
  ['--text-muted', '--bg'],
  ['--text-muted', '--bg-panel'],
  ['--text-muted', '--bg-panel-2'],
  ['--text', '--bg-overlay'],
  ['--text-muted', '--bg-overlay'],
  ['--accent-fg', '--accent'],
  ['--accent-fg', '--accent-strong'],
  ['--accent', '--bg-panel'],
  ['--accent-text', '--accent-bg'],
  ['--ok-text', '--ok-bg'],
  ['--warn-text', '--warn-bg'],
  ['--danger-fg', '--danger'],
  ['--danger', '--bg-panel'],
  ['--toast-text', '--toast-bg'],
  ['--toast-text', '--toast-warn-bg'],
];

test('theme modes have matching CSS variable keys and are frozen', () => {
  assert.deepEqual(Object.keys(TOKENS.light).sort(), Object.keys(TOKENS.dark).sort());
  assert.ok(Object.keys(TOKENS.light).every((key) => key.startsWith('--')));
  for (const value of [TOKENS, TOKENS.light, TOKENS.dark]) assert.ok(Object.isFrozen(value));
  const a = { '--bg': 'white' };
  const b = { '--bg': 'black' };
  const tokens = defineTokens(a, b);
  assert.equal(Object.isFrozen(a), false);
  for (const value of [tokens, tokens.light, tokens.dark]) assert.ok(Object.isFrozen(value));
});

test('token definitions reject missing, extra, invalid keys and non-plain objects', () => {
  assert.throws(() => defineTokens({ '--bg': 'white' }, {}), /missing.*--bg/i);
  assert.throws(() => defineTokens({}, { '--extra': 'black' }), /extra.*--extra/i);
  assert.throws(() => defineTokens({ bg: 'white' }, { bg: 'black' }), /--/);
  for (const invalid of [null, [], 'white', 1, new Date()]) {
    assert.throws(() => defineTokens(invalid, {}), Error);
    assert.throws(() => defineTokens({}, invalid), Error);
  }
});

test('normal text token pairs meet WCAG AA contrast in both modes', () => {
  for (const [mode, tokens] of Object.entries(TOKENS)) {
    for (const [foreground, background] of TEXT_BACKGROUND_PAIRS) {
      assert.ok(Object.hasOwn(tokens, foreground), `${mode}: missing ${foreground}`);
      assert.ok(Object.hasOwn(tokens, background), `${mode}: missing ${background}`);
      const opaqueBackground = compositeOver(tokens[background], tokens['--bg']);
      const ratio = contrastRatio(tokens[foreground], opaqueBackground);
      assert.ok(ratio >= MIN_NORMAL_TEXT_CONTRAST_RATIO,
        `${mode}: ${foreground} on ${background} contrast ${ratio} < ${MIN_NORMAL_TEXT_CONTRAST_RATIO}`);
    }
  }
});

test('JSX, HTML and CSS token references resolve in both theme modes', () => {
  const sourceDirectory = new URL('./', import.meta.url);
  const sourceFiles = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith('.jsx') || name.endsWith('.css')).map((name) => `src/${name}`);
  const scannedFiles = ['RetroBoard.jsx', 'index.html', ...sourceFiles];
  const unresolved = [];
  for (const file of scannedFiles) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const references = new Set([...source.matchAll(TOKEN_REFERENCE_PATTERN)].map((match) => match[1]));
    for (const name of references) {
      if (name.startsWith(COMPONENT_LOCAL_TOKEN_PREFIX)) continue;
      for (const [mode, tokens] of Object.entries(TOKENS)) {
        if (!Object.hasOwn(tokens, name)) unresolved.push(`${file}: ${mode} missing ${name}`);
      }
    }
  }
  assert.deepEqual(unresolved, [], `Unresolved theme tokens:\n${unresolved.join('\n')}`);
});
