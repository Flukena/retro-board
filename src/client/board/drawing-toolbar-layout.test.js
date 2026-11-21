import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Contract: on a phone every tool and Close sit in the top row without scrolling; only the options row scrolls.
const css = readFileSync(new URL('./drawing-tool.css', import.meta.url), 'utf8');
const MOBILE_MEDIA_START = '@media (max-width: 767px)';
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const mobileBlock = css.slice(css.indexOf(MOBILE_MEDIA_START)).replaceAll(CSS_COMMENT, '');

/** Declarations of every mobile rule whose selector list contains exactly `selector`, later rules winning. */
function mobileDeclarations(selector) {
  const declarations = {};
  for (const [, selectors, body] of mobileBlock.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((candidate) => candidate.trim() === selector)) continue;
    for (const [, property, value] of body.matchAll(/([a-z-]+)\s*:\s*([^;]+);?/g)) declarations[property] = value.trim();
  }
  return declarations;
}

const OPTION_ROW_NAME = 'options';
const gridRows = () => mobileDeclarations('.rb-drawing-toolbar')['grid-template-areas']
  .match(/"[^"]+"/g).map((row) => row.slice(1, -1).trim().split(/\s+/));

test('mobile Draw toolbar: every tool and Close share the top row, so nothing needs scrolling to be found', () => {
  const [top] = gridRows();
  assert.ok(top.includes('tools') && top.includes('close'), `top row must hold the tools and Close: ${top}`);
  assert.ok(!top.includes('undo') && !top.includes('redo') && !top.includes(OPTION_ROW_NAME), 'history and options must not crowd the top row');
  for (const property of ['overflow', 'overflow-x']) {
    assert.equal(mobileDeclarations('.rb-drawing-tools')[property], undefined, 'a scrolling tools group hides tools such as the eraser');
  }
});

test('mobile Draw toolbar: Undo and Redo sit pinned at the start of the row below, before the scrolling options', () => {
  const second = gridRows()[1];
  assert.deepEqual(second.slice(0, 2), ['undo', 'redo']);
  assert.ok(second.slice(2).every((cell) => cell === OPTION_ROW_NAME), 'the rest of the row is the options');
  assert.match(mobileDeclarations(`.rb-drawing-${OPTION_ROW_NAME}`)['overflow-x'], /^(auto|scroll)$/, 'only sizes and colours scroll');
});

test('mobile Draw toolbar: action buttons are placed on the grid individually, not as one wrapper', () => {
  assert.equal(mobileDeclarations('.rb-drawing-actions').display, 'contents');
  const areas = new Set(gridRows().flat());
  for (const action of ['undo', 'redo', 'close']) {
    const placement = mobileDeclarations(`.rb-drawing-actions [data-drawing-action="${action}"]`)['grid-area'];
    assert.equal(placement, action);
    assert.ok(areas.has(placement), `${action} has no named grid area`);
  }
});

test('mobile Draw toolbar: tool and action buttons keep their touch size', () => {
  for (const selector of ['.rb-drawing-tools button', '.rb-drawing-actions button']) {
    const rule = mobileDeclarations(selector);
    assert.equal(rule['min-width'], 'var(--modal-touch-target)', selector);
    assert.equal(rule['min-height'], 'var(--modal-touch-target)', selector);
  }
});

test('mobile Draw toolbar: direct children outside the named areas take a full row of their own', () => {
  // The retry button is the only direct button child (the others live in the tools/options/actions groups).
  // Left to auto-place it falls into the first auto track and stretches Undo and squeezes the options.
  assert.equal(mobileDeclarations('.rb-drawing-toolbar > button')['grid-column'], '1 / -1');
  // The status line must stay out of the grid flow, or it becomes another auto-placed item.
  assert.equal(mobileDeclarations('.rb-drawing-status').position, 'absolute');
});

test('mobile Draw toolbar: the status is anchored to the toolbar edge, not to a viewport constant that a taller toolbar covers', () => {
  const status = mobileDeclarations('.rb-drawing-status');
  assert.equal(mobileDeclarations('.rb-drawing-toolbar').position, undefined, 'the toolbar stays fixed (base rule) and so contains the status');
  assert.match(css.split('@media')[0], /\.rb-drawing-toolbar \{[^}]*position: fixed/);
  assert.match(status.bottom, /^calc\(100% \+ var\(--[a-z0-9-]+\)\)$/, 'sits just above the toolbar whatever its height');
  // The status starts where the canvas starts, to the right of the tool rail, expressed in the toolbar's own coordinates.
  assert.equal(status.left, 'calc(var(--rb-mobile-canvas-left-px) - var(--rb-mobile-left-px))', 'on short phones the rail runs down to the status');
  assert.equal(status.right, '0');
  assert.doesNotMatch(status.bottom, /touch-target|mobile-bottom/, 'a constant offset cannot clear a two or three row toolbar');
});
