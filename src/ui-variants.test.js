import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUTTON_VARIANT, MENU_ITEM_VARIANT, DIVIDER_ORIENTATION, SURFACE_KIND,
  buttonClass, menuItemClass, dividerClass, topBarButtonVariant, surfaceClass,
} from './ui-variants.js';

const CONTRACTS = [
  ['surface', SURFACE_KIND, surfaceClass],
  ['button', BUTTON_VARIANT, buttonClass],
  ['menu item', MENU_ITEM_VARIANT, menuItemClass],
  ['divider', DIVIDER_ORIENTATION, dividerClass],
];
const CSS_CLASS_SELECTOR_PATTERN = /\.([a-z][\w-]*)/g;

for (const [name, values, mapper] of CONTRACTS) {
  test(`${name} mapper rejects unknown values`, () => {
    for (const invalid of ['unknown', undefined, null, 'toString', {}]) {
      assert.throws(() => mapper(invalid), /Unknown/, `${name} must reject unknown values`);
    }
  });
  test(`${name} enum is frozen and each value has a distinct class string`, () => {
    assert.ok(Object.isFrozen(values));
    const classes = Object.values(values).map(mapper);
    assert.equal(new Set(classes).size, Object.values(values).length);
  });
  test(`${name} emitted classes have CSS selectors`, () => {
    const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
    const selectors = new Set([...css.matchAll(CSS_CLASS_SELECTOR_PATTERN)].map((match) => match[1]));
    for (const value of Object.values(values)) {
      for (const className of mapper(value).split(/\s+/)) {
        assert.ok(selectors.has(className), `Missing CSS selector: .${className}`);
      }
    }
  });
}

test('top-bar activity selects the active variant only when active', () => {
  assert.equal(topBarButtonVariant({ active: true }), BUTTON_VARIANT.ACTIVE);
  assert.equal(topBarButtonVariant({ active: false }), BUTTON_VARIANT.DEFAULT);
  assert.equal(topBarButtonVariant({}), BUTTON_VARIANT.DEFAULT);
});
