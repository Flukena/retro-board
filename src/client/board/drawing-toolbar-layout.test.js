import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Contract: on a phone the Draw toolbar's top row can never push Undo, Redo or Close past the viewport.
// The tools group gives way (it shrinks and scrolls); the actions group never does.
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

const SHRINKABLE_TRACK = /^minmax\(\s*0(px)?\s*,\s*1fr\s*\)$/;
const SCROLLING_OVERFLOW = /^(auto|scroll)$/;

test('mobile Draw toolbar: the tools track can shrink below its content and the actions track cannot', () => {
  const [toolsTrack, actionsTrack, ...extraTracks] = mobileDeclarations('.rb-drawing-toolbar')['grid-template-columns'].split(/\s+(?![^(]*\))/);
  assert.deepEqual(extraTracks, []);
  assert.match(toolsTrack, SHRINKABLE_TRACK, 'a plain 1fr track will not shrink below the tool buttons, so the row overflows the viewport');
  assert.match(actionsTrack, /^(auto|max-content)$/, 'the actions track must size to its three buttons and never give way');
});

test('mobile Draw toolbar: the tools group scrolls instead of overflowing, the actions group is never clipped', () => {
  const tools = mobileDeclarations('.rb-drawing-tools');
  assert.equal(tools['min-width'], '0', 'a grid item with min-width:auto cannot shrink to its track');
  assert.match(tools['overflow-x'], SCROLLING_OVERFLOW);
  assert.equal(tools['overscroll-behavior-x'], 'contain', 'same scroll containment as the options row');
  const actions = mobileDeclarations('.rb-drawing-actions');
  assert.equal(actions['overflow-x'] ?? actions.overflow, undefined, 'clipping or scrolling the actions would hide Close');
  assert.notEqual(actions['min-width'], '0');
});

test('mobile Draw toolbar: scrolling tool buttons and action buttons keep their touch size', () => {
  assert.equal(mobileDeclarations('.rb-drawing-tools > *')['flex-shrink'], '0', 'tool buttons scroll, they do not squash');
  assert.equal(mobileDeclarations('.rb-drawing-actions > *')['flex-shrink'], '0');
  for (const selector of ['.rb-drawing-tools button', '.rb-drawing-actions button']) {
    const rule = mobileDeclarations(selector);
    assert.equal(rule['min-width'], 'var(--modal-touch-target)', selector);
    assert.equal(rule['min-height'], 'var(--modal-touch-target)', selector);
  }
});
