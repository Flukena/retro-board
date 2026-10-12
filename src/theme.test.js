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
  ['--sticky-vote-text', '--sticky-vote-bg'],
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

const CARD_MODE_TOKENS = ['--zone-fill-alpha', '--shadow-sticky', '--shadow-sticky-flat', '--sticky-vote-bg', '--sticky-vote-text'];
const CARD_SHARED_TOKENS = [
  '--sticky-ink', '--sticky-vote-idle-bg', '--sticky-vote-idle-text',
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
  const componentSource = ['../RetroBoard.jsx', './ZoneCard.jsx']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  const inlineNames = new Set([...componentSource.matchAll(/['"](--rb-[\w-]+)['"]\s*:/g)]
    .map((match) => match[1]));
  for (const [, name] of css.matchAll(TOKEN_REFERENCE_PATTERN)) {
    if (name.startsWith(COMPONENT_LOCAL_TOKEN_PREFIX)) {
      assert.ok(Object.hasOwn(supplied, name) || inlineNames.has(name), `Missing inline producer for ${name}`);
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

test('modal appearance tokens resolve in both themes', () => {
  for (const tokens of Object.values(TOKENS)) {
    for (const name of ['--bg-modal-veil', '--bg-elev', '--border', '--radius-lg', '--shadow-modal']) {
      assert.ok(tokens[name], 'Missing modal token ' + name);
    }
  }
});

test('minimap grid and viewport highlight tokens resolve in both modes', () => {
  for (const tokens of Object.values(TOKENS)) {
    assert.equal(tokens['--minimap-grid-pitch'], '10px');
    assert.equal(tokens['--minimap-panel-blur'], '12px');
    assert.equal(tokens['--radius-minimap-viewport'], '4px');
    assert.ok(tokens['--minimap-viewport-highlight']);
  }
  assert.notEqual(TOKENS.light['--minimap-viewport-highlight'], TOKENS.dark['--minimap-viewport-highlight']);
});

test('zone chip keeps design screen dimensions in both themes', () => {
  for (const tokens of Object.values(TOKENS)) {
    assert.equal(tokens['--zone-header-inset'], '14px');
    assert.equal(tokens['--zone-title-font-size'], '16px');
    assert.equal(tokens['--zone-chip-padding'], '6px 14px');
    assert.equal(tokens['--zone-chip-gap'], '8px');
    assert.equal(tokens['--zone-title-line-height'], '1.35');
    assert.equal(tokens['--zone-count-font-size'], '11px');
    assert.equal(tokens['--zone-lock-size'], '0.8125em');
  }
});

test('design C sticky tokens preserve geometry, typography, signals and mode-specific vote paint', () => {
  const shared = {
    '--sticky-padding': '14px', '--radius-sticky': '3px', '--sticky-line-height': '1.5',
    '--sticky-chip-height': '22px', '--comment-chip-padding': '0 7px',
    '--comment-chip-font-size': '11px', '--comment-chip-font-weight': '600',
    '--comment-chip-bg': 'rgba(255,255,255,0.65)', '--comment-chip-text': '#374151',
    '--sticky-vote-min-width': '32px', '--sticky-vote-padding': '0 9px',
    '--sticky-vote-font-size': '12px', '--sticky-vote-font-weight': '700',
    '--sticky-vote-idle-bg': 'rgba(43,33,24,0.08)', '--sticky-vote-idle-text': '#374151',
    '--sticky-vote-open-ring': '0 0 0 1.5px var(--accent)',
    '--sticky-medal-size': '28px', '--sticky-medal-offset': '-13px',
    '--sticky-medal-font-size': '13px', '--sticky-medal-font-weight': '700',
    '--shadow-medal': '0 0 0 2px #fffcf6, 0 4px 10px rgba(0,0,0,0.18)',
    '--shadow-winner': '0 0 0 3px #fbbf24, 0 16px 22px -12px rgba(194,120,3,0.65)',
    '--sticky-hidden-icon-size': '18px', '--sticky-hidden-title-size': '13px',
    '--sticky-hidden-title-weight': '600', '--sticky-hidden-author-size': '11px',
    '--sticky-hidden-author-weight': '500', '--sticky-hidden-text': '#4b5563',
    '--sticky-author-font-size': '11px', '--selection': '#2563eb',
  };
  for (const tokens of Object.values(TOKENS)) {
    for (const [name, value] of Object.entries(shared)) assert.equal(tokens[name], value, name);
    assert.ok(tokens['--font-ui'].includes('Sarabun'));
    assert.ok(tokens['--font-display'].includes('Mitr'));
  }
  assert.equal(TOKENS.light['--sticky-vote-bg'], '#2b2118');
  assert.equal(TOKENS.light['--sticky-vote-text'], '#ffffff');
  assert.equal(TOKENS.dark['--sticky-vote-bg'], '#f3ebdf');
  assert.equal(TOKENS.dark['--sticky-vote-text'], '#1b1814');
  assert.equal(TOKENS.light['--shadow-sticky'], '0 1px 1px rgba(110,80,40,0.12), 0 16px 18px -14px rgba(110,80,40,0.55)');
  assert.equal(TOKENS.dark['--shadow-sticky'], '0 1px 1px rgba(0,0,0,0.4), 0 18px 20px -14px rgba(0,0,0,0.9)');
});

function cardDeclarations(selector) {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8');
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const rule = rules.find((match) => match[1].trim() === selector);
  assert.ok(rule, selector);
  return Object.fromEntries(rule[2].split(';').filter((entry) => entry.includes(':')).map((entry) => {
    const separator = entry.indexOf(':');
    return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
  }));
}

test('sticky CSS consumes design tokens in full and overview paths without resizing states', () => {
  const contracts = [
    ['.rb-sticky,\n.rb-card-overview', { padding: 'var(--sticky-padding)', 'line-height': 'var(--sticky-line-height)', 'font-family': 'var(--font-ui)' }],
    ['.rb-sticky__comment-chip', { height: 'var(--sticky-chip-height)', padding: 'var(--comment-chip-padding)', border: 'none', 'border-radius': 'var(--radius-pill)', 'font-size': 'var(--comment-chip-font-size)', 'font-weight': 'var(--comment-chip-font-weight)', color: 'var(--comment-chip-text)' }],
    ['.rb-card-overview__vote,\n.rb-sticky__vote-pill', { height: 'var(--sticky-chip-height)', 'min-width': 'var(--sticky-vote-min-width)', padding: 'var(--sticky-vote-padding)', 'font-size': 'var(--sticky-vote-font-size)', 'font-weight': 'var(--sticky-vote-font-weight)', 'font-family': 'var(--font-display)', 'border-radius': 'var(--radius-pill)', border: 'none' }],
    ['.rb-sticky-vote--open', { 'box-shadow': 'var(--sticky-vote-open-ring)' }],
    ['.rb-sticky__hidden', { color: 'var(--sticky-hidden-text)' }],
    ['.rb-sticky__hidden-icon', { width: 'var(--sticky-hidden-icon-size)', height: 'var(--sticky-hidden-icon-size)' }],
    ['.rb-sticky__hidden-title', { 'font-size': 'var(--sticky-hidden-title-size)', 'font-weight': 'var(--sticky-hidden-title-weight)' }],
    ['.rb-sticky__hidden-author', { 'font-size': 'var(--sticky-hidden-author-size)', 'font-weight': 'var(--sticky-hidden-author-weight)', color: 'inherit' }],
    ['.rb-sticky__author', { 'font-size': 'var(--sticky-author-font-size)', color: 'var(--text-muted)', 'text-overflow': 'ellipsis' }],
    ['.rb-winner-medal', { top: 'var(--sticky-medal-offset)', left: 'var(--sticky-medal-offset)', width: 'var(--sticky-medal-size)', height: 'var(--sticky-medal-size)', 'font-size': 'var(--sticky-medal-font-size)', 'font-weight': 'var(--sticky-medal-font-weight)', 'box-shadow': 'var(--shadow-medal)' }],
  ];
  for (const [selector, expected] of contracts) {
    const actual = cardDeclarations(selector);
    for (const [property, value] of Object.entries(expected)) assert.equal(actual[property], value, selector + ' ' + property);
  }
  assert.equal(cardDeclarations('.rb-sticky__editor')['line-height'], 'var(--sticky-line-height)');
  assert.equal(cardDeclarations('.rb-sticky__comment-preview-slide')['text-overflow'], 'ellipsis');
  assert.ok(!cardDeclarations('.rb-sticky__vote-pill').transition.includes('padding'));
  assert.ok(!cardDeclarations('.rb-sticky__vote-pill').transition.includes('font-size'));
});
