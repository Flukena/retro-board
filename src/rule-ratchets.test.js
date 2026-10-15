import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const REPO_ROOT = new URL('../', import.meta.url);
// AGENTS.md: frozen in size. These line ceilings may only be lowered, never raised.
const RETRO_BOARD_MAX_LINES = 4505;
const YJS_SERVER_MAX_LINES = 2241;
const LINE_CEILINGS = new Map([
  ['RetroBoard.jsx', RETRO_BOARD_MAX_LINES],
  ['yjs-server.mjs', YJS_SERVER_MAX_LINES],
]);
const ALLOWED_COLOUR_REASONS = new Map([
  ['#2563eb', 'Functional selection outline'],
  ['rgba(37,99,235,0.10)', 'Functional drag-selection fill'],
  ['hsl(var(--rb-selector-hue) 78% 52% / 0.72)', 'Remote selection resting inner glow'],
  ['hsl(var(--rb-selector-hue) 82% 55% / 0.42)', 'Remote selection resting middle glow'],
  ['hsl(var(--rb-selector-hue) 86% 60% / 0.18)', 'Remote selection resting outer glow'],
  ['hsl(var(--rb-selector-hue) 82% 50% / 0.90)', 'Remote selection pulse inner glow'],
  ['hsl(var(--rb-selector-hue) 86% 55% / 0.58)', 'Remote selection pulse middle glow'],
  ['hsl(var(--rb-selector-hue) 90% 62% / 0.28)', 'Remote selection pulse outer glow'],
]);
const HEX_COLOUR_PATTERN = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3})\b/gi;
const COLOUR_FUNCTION_START_PATTERN = /\b(?:rgba?|hsla?)\s*\(/gi;

export function assertLineCeiling(source, maxLines, label) {
  const lines = source.split('\n').length - Number(source.endsWith('\n'));
  assert.ok(lines <= maxLines, `${label}: ${lines} lines exceeds ceiling ${maxLines}`);
}

function readColourFunction(source, startIndex) {
  let depth = 0;
  for (let index = source.indexOf('(', startIndex); index < source.length; index++) {
    const character = source[index];
    if (character === '(') depth++;
    if (character === ')') {
      depth--;
      if (depth === 0) return source.slice(startIndex, index + 1);
    }
  }
  return source.slice(startIndex);
}

export function forbiddenColourLiterals(source) {
  const hexColours = Array.from(source.matchAll(HEX_COLOUR_PATTERN), match => match[0]);
  const functionColours = Array.from(source.matchAll(COLOUR_FUNCTION_START_PATTERN),
    match => readColourFunction(source, match.index));
  return [...hexColours, ...functionColours].filter(colour => !ALLOWED_COLOUR_REASONS.has(colour));
}

for (const [filename, maxLines] of LINE_CEILINGS) {
  test(`${filename} stays within its frozen line ceiling`, () => {
    assertLineCeiling(readFileSync(new URL(filename, REPO_ROOT), 'utf8'), maxLines, filename);
  });
}

const jsxFiles = ['RetroBoard.jsx', ...readdirSync(new URL('src/', REPO_ROOT))
  .filter(filename => filename.endsWith('.jsx')).map(filename => `src/${filename}`)];

for (const filename of jsxFiles) {
  test(`${filename} uses colour tokens or explicitly allowed functional signals`, () => {
    const source = readFileSync(new URL(filename, REPO_ROOT), 'utf8');
    assert.deepEqual(forbiddenColourLiterals(source), [], filename);
  });
}

test('line ceiling rejects an in-memory extra line with or without a final newline', () => {
  const SAMPLE_MAX_LINES = 2;
  const AT_CEILING_SOURCE = 'first\nsecond\n';
  const OVER_CEILING_SOURCE = `${AT_CEILING_SOURCE}third`;
  assert.doesNotThrow(() => assertLineCeiling(AT_CEILING_SOURCE, SAMPLE_MAX_LINES, 'sample'));
  assert.doesNotThrow(() => assertLineCeiling(AT_CEILING_SOURCE.trimEnd(), SAMPLE_MAX_LINES, 'sample'));
  assert.throws(() => assertLineCeiling(OVER_CEILING_SOURCE, SAMPLE_MAX_LINES, 'sample'), assert.AssertionError);
  assert.throws(() => assertLineCeiling(`${OVER_CEILING_SOURCE}\n`, SAMPLE_MAX_LINES, 'sample'), assert.AssertionError);
});

test('colour scanner rejects in-memory forbidden CSS colour forms', () => {
  const FORBIDDEN_COLOURS = ['#f00', '#ff0000', '#ff000080', '#FF0000',
    'rgb(255, 0, 0)', 'rgba(255,0,0,0.5)', 'hsl(0 100% 50%)',
    'hsl(var(--new-hue) 100% 50%)', 'RGB (255 0 0)', 'hsla(0,100%,50%,0.5)',
    '#2563eb80', 'rgba(37,99,235,0.11)'];
  for (const colour of FORBIDDEN_COLOURS) {
    assert.deepEqual(forbiddenColourLiterals(`background: ${colour};`), [colour]);
  }
});

test('colour scanner accepts tokens and functional selection signals', () => {
  const TOKEN_SOURCE = 'color: var(--text); box-shadow: var(--shadow-winner);';
  const SELECTION_SOURCE = 'border: 2px solid #2563eb; background: rgba(37,99,235,0.10);';
  assert.deepEqual(forbiddenColourLiterals(TOKEN_SOURCE), []);
  assert.deepEqual(forbiddenColourLiterals(SELECTION_SOURCE), []);
});
