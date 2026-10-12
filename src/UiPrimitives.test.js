import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { BUTTON_VARIANT, MENU_ITEM_VARIANT, DIVIDER_ORIENTATION, SURFACE_KIND } from './ui-variants.js';

const TEST_LABEL = 'Action';
const TEST_EXTRA_CLASS = 'caller-class';

test('UI primitives preserve native button and accessibility contracts', async (context) => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  try {
    const { Button, MenuItem, Divider, Surface } = await server.ssrLoadModule('/src/UiPrimitives.jsx');
    await context.test('disabled-look buttons keep the click handler and omit native disabled', () => {
      let clicks = 0;
      const onClick = () => { clicks += 1; };
      const button = Button({ disabledLook: true, onClick, title: TEST_LABEL, children: TEST_LABEL });
      assert.equal(button.type, 'button');
      assert.equal(button.props.type, 'button');
      assert.equal(button.props['aria-disabled'], true);
      assert.equal(button.props.disabled, undefined);
      assert.equal(button.props.title, TEST_LABEL);
      assert.equal(button.props.children, TEST_LABEL);
      button.props.onClick();
      assert.equal(clicks, 1);
      assert.equal(Button({}).props['aria-disabled'], undefined);
    });
    await context.test('button variants retain caller classes', () => {
      const button = Button({ variant: BUTTON_VARIANT.ACTIVE, className: TEST_EXTRA_CLASS });
      assert.ok(button.props.className.split(' ').includes(TEST_EXTRA_CLASS));
      assert.throws(() => Button({ variant: 'unknown' }), /Unknown/);
    });
    await context.test('menu items preserve native disabled, checked and caller icons', () => {
      const icon = 'icon';
      const checkIcon = 'check';
      const onClick = () => {};
      const item = MenuItem({ icon, label: TEST_LABEL, checked: true, disabled: true,
        onClick, checkIcon, variant: MENU_ITEM_VARIANT.DANGER });
      assert.equal(item.props.type, 'button');
      assert.equal(item.props.disabled, true);
      assert.equal(item.props.onClick, onClick);
      assert.equal(item.props['aria-pressed'], true);
      assert.equal(item.props.children[0].props.children, icon);
      assert.equal(item.props.children[1].props.children, TEST_LABEL);
      assert.equal(item.props.children[2], checkIcon);
      const unchecked = MenuItem({ checked: false, checkIcon });
      assert.equal(unchecked.props['aria-pressed'], false);
      assert.equal(unchecked.props.children[2], false);
      assert.equal(MenuItem({}).props['aria-pressed'], undefined);
    });
    await context.test('menu items omit absent icon slots and retain supplied icons', () => {
      for (const icon of [null, undefined]) {
        assert.doesNotMatch(renderToStaticMarkup(MenuItem({ icon, label: TEST_LABEL })), /rb-menu-item__icon/);
      }
      assert.match(renderToStaticMarkup(MenuItem({ icon: 'icon', label: TEST_LABEL })), /rb-menu-item__icon/);
    });
    await context.test('surfaces preserve content, attributes and validate kind', () => {
      const surface = Surface({ kind: SURFACE_KIND.POPOVER, className: TEST_EXTRA_CLASS, children: TEST_LABEL, 'data-board-shortcuts': 'off' });
      assert.equal(surface.type, 'div');
      assert.equal(surface.props.children, TEST_LABEL);
      assert.equal(surface.props['data-board-shortcuts'], 'off');
      assert.ok(surface.props.className.split(' ').includes(TEST_EXTRA_CLASS));
      assert.throws(() => Surface({ kind: 'unknown' }), /Unknown/);
    });
    await context.test('dividers are decorative and reject unknown orientations', () => {
      for (const orientation of Object.values(DIVIDER_ORIENTATION)) {
        const divider = Divider({ orientation });
        assert.equal(divider.type, 'div');
        assert.equal(divider.props['aria-hidden'], true);
      }
      assert.throws(() => Divider({ orientation: 'unknown' }), /Unknown/);
    });
  } finally {
    await server.close();
  }
});
