import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { Z } from './chrome-layout.js';

test('shell preserves opt-in dismissal, labels, layers and dialog attribute absence', async () => {
  await withChromeModule('/src/ModalShell.jsx', ({ ModalShell }) => {
    const plain = ModalShell({ children: 'body' });
    assert.equal(plain.props.onClick, undefined);
    assert.equal(plain.props.role, undefined);
    assert.equal(plain.props['aria-modal'], undefined);
    assert.equal(plain.props.style.zIndex, Z.MODAL);
    const dismiss = () => {};
    const dialog = ModalShell({ onDismiss: dismiss, labelledBy: 'title', layer: 'raised', role: 'dialog' });
    assert.equal(dialog.props.onClick, dismiss);
    assert.equal(dialog.props.style.zIndex, Z.MODAL_RAISED);
    assert.match(renderToStaticMarkup(dialog), /aria-labelledby="title"/);
    let stopped = false;
    dialog.props.children.props.onClick({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
    assert.equal(plain.props.children.props.onClick, undefined);
    for (const props of [{ size: 'unknown' }, { layer: 'unknown' }]) {
      assert.throws(() => ModalShell(props), /Unknown/);
    }
  });
});
