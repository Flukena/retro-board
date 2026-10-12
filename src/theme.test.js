import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stickyCardVars, zoneCardVars, medalLook } from './card-look.js';
import { PALETTE } from './palette.js';
import { defineTokens, TOKENS } from './theme.js';
import { compositeOver, contrastRatio } from './color-contrast.js';

const MIN_NORMAL_TEXT_CONTRAST_RATIO = 4.5; // WCAG 2.2 SC 1.4.3.
const COMPONENT_LOCAL_TOKEN_PREFIX = '--rb-';
const TOKEN_REFERENCE_PATTERN = /var\(\s*(--[\w-]+)/g;
const TEXT_BACKGROUND_PAIRS = [
  ['--sticky-vote-text', '--sticky-ink'],
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

const CARD_MODE_TOKENS = ['--zone-fill-alpha', '--shadow-sticky', '--shadow-sticky-flat'];
const CARD_SHARED_TOKENS = [
  '--sticky-ink', '--sticky-vote-text', '--sticky-vote-idle-bg', '--sticky-vote-idle-text',
  '--sticky-placeholder', '--zone-border-alpha',
  '--selection', '--radius-sticky', '--radius-zone', '--zone-title-shadow',
  '--shadow-winner', '--shadow-winner-peak', '--shadow-medal',
  '--comment-chip-bg', '--comment-chip-shadow', '--hidden-sticky-bg', '--vote-float-shadow',
];

test('board card tokens exist in both modes with fixed selection and mode-specific fill', () => {
  for (const tokens of Object.values(TOKENS)) {
    for (const name of [...CARD_MODE_TOKENS, ...CARD_SHARED_TOKENS]) {
      assert.ok(tokens[name], `Missing card token ${name}`);
    }
    assert.equal(tokens['--selection'], '#2563eb');
    assert.equal(tokens['--radius-sticky'], '3px');
    assert.equal(tokens['--radius-zone'], '24px');
  }
  assert.equal(TOKENS.light['--zone-fill-alpha'], '0.13');
  assert.equal(TOKENS.dark['--zone-fill-alpha'], '0.10');
  for (const name of CARD_SHARED_TOKENS) assert.equal(TOKENS.light[name], TOKENS.dark[name]);
});

test('every component-local board CSS variable has an inline producer', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8');
  const supplied = {
    ...stickyCardVars(PALETTE[0]), ...zoneCardVars(PALETTE[0]), ...medalLook(1),
  };
  for (const [, name] of css.matchAll(TOKEN_REFERENCE_PATTERN)) {
    if (name.startsWith(COMPONENT_LOCAL_TOKEN_PREFIX)) {
      assert.ok(Object.hasOwn(supplied, name), `Missing inline producer for ${name}`);
    }
  }
});

test('idle vote text meets AA contrast on its composited background over each pastel', () => {
  for (const [mode, tokens] of Object.entries(TOKENS)) {
    for (const { name, bg } of PALETTE) {
      const background = compositeOver(tokens['--sticky-vote-idle-bg'], bg);
      const ratio = contrastRatio(tokens['--sticky-vote-idle-text'], background);
      assert.ok(ratio >= MIN_NORMAL_TEXT_CONTRAST_RATIO,
        `${mode}: idle vote text on ${name} contrast ${ratio} < ${MIN_NORMAL_TEXT_CONTRAST_RATIO}`);
    }
  }
});

test('toast shadow resolves in both modes', () => {
  for (const tokens of Object.values(TOKENS)) {
    for (const name of ['--shadow-toast', '--minimap-viewport-bg', '--zone-preview-bg']) assert.ok(tokens[name]);
  }
});
