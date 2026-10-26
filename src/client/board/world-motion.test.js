import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { worldMotionProps, WORLD_MOTION_ATTRIBUTE, WORLD_MOTION_STILL } from './world-motion.js';

const webkit = { GestureEvent: class {} };

test('a dense board on WebKit holds every animation inside the world still', () => {
  assert.deepEqual(worldMotionProps(true, webkit), { [WORLD_MOTION_ATTRIBUTE]: WORLD_MOTION_STILL });
});

test('small boards and non-WebKit browsers keep their motion', () => {
  assert.deepEqual(worldMotionProps(false, webkit), {});
  assert.deepEqual(worldMotionProps(true, {}), {});
});

test('the still world rule stops both animations and transitions of its descendants', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8');
  const rule = css.match(new RegExp(`\\[${WORLD_MOTION_ATTRIBUTE}="${WORLD_MOTION_STILL}"\\] \\*\\s*\\{([^}]*)\\}`));
  assert.ok(rule, 'board-cards.css must define the still-world rule');
  assert.match(rule[1], /animation:\s*none !important/);
  assert.match(rule[1], /transition:\s*none !important/);
});
