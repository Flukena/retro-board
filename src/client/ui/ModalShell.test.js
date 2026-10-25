import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { Z } from '../chrome/chrome-layout.js';

function inspectShell(ModalShell, props) {
  let tree;
  function Inspect() { tree = ModalShell(props); return tree; }
  const html = renderToStaticMarkup(React.createElement(Inspect));
  return { tree, html };
}

test('dismissible shell has a visible accessible close button outside its scrolling content', async () => {
  await withChromeModule('/src/client/ui/ModalShell.jsx', ({ ModalShell }, { t }) => {
    let closes = 0;
    const dismiss = () => { closes++; };
    const { tree, html } = inspectShell(ModalShell, {
      onDismiss: dismiss, labelledBy: 'title', layer: 'raised', children: 'body',
    });
    assert.equal(tree.props.style.zIndex, Z.MODAL_RAISED);
    assert.match(html, /aria-labelledby="title"/);
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /class="rb-modal__content"/);
    const panel = tree.props.children;
    const close = panel.props.children.find(child => child?.props?.['aria-label'] === t('common.close'));
    assert.ok(close, 'Every dismissible dialog needs a close button independent of its content scroll');
    close.props.onClick();
    assert.equal(closes, 1);
    let stopped = false;
    panel.props.onClick({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
  });
});

test('busy dismissal cannot abandon a pending operation, while an idle backdrop cancels', async () => {
  await withChromeModule('/src/client/ui/ModalShell.jsx', ({ ModalShell }, { t }) => {
    let closes = 0;
    const onDismiss = () => { closes++; };
    const { tree } = inspectShell(ModalShell, { onDismiss, dismissDisabled: true });
    assert.equal(tree.props.onClick, undefined);
    const close = tree.props.children.props.children.find(child => child?.props?.['aria-label'] === t('common.close'));
    assert.equal(close.props.disabled, true);
    const idle = inspectShell(ModalShell, { onDismiss }).tree;
    idle.props.onClick();
    assert.equal(closes, 1);
    for (const props of [{ size: 'unknown' }, { layer: 'unknown' }]) {
      assert.throws(() => inspectShell(ModalShell, props), /Unknown/);
    }
  });
});
