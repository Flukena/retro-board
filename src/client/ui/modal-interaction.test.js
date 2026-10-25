import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeModalInteraction } from './modal-interaction.js';

function modalFixture() {
  const document = new EventTarget();
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 340, width: 390, offsetTop: 24, offsetLeft: 0 });
  const scheduled = new Map();
  document.defaultView = {
    visualViewport: viewport,
    requestAnimationFrame(fn) { const id = scheduled.size; scheduled.set(id, fn); return id; },
    cancelAnimationFrame(id) { scheduled.delete(id); },
  };
  const controls = ['first', 'last'].map(name => ({
    name, tabIndex: 0, getClientRects: () => [{}],
    focus() { document.activeElement = this; }, scrollIntoView() {},
  }));
  const panel = {
    ownerDocument: document,
    querySelectorAll: () => controls,
    contains: element => controls.includes(element),
    focus() { document.activeElement = this; },
  };
  const styles = new Map();
  const overlay = {
    ownerDocument: document, querySelector: () => panel,
    style: { zIndex: 1, setProperty: (key, value) => styles.set(key, value) },
  };
  document.querySelectorAll = () => [overlay];
  let dismissed = 0;
  let restored = 0;
  const cleanup = subscribeModalInteraction(overlay, {
    dismiss: () => { dismissed++; }, opener: { isConnected: true, focus: () => { restored++; } },
  });
  return { document, viewport, controls, overlay, styles, cleanup,
    dismissed: () => dismissed, restored: () => restored,
    flush() { for (const fn of scheduled.values()) fn(); scheduled.clear(); },
    pending: () => scheduled.size,
  };
}

function key(document, name, options = {}) {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key: name, ...options });
  document.dispatchEvent(event);
  return event;
}

test('Escape dismisses only the top dialog and leaves composing input alone', () => {
  const fixture = modalFixture();
  key(fixture.document, 'Escape', { isComposing: true });
  assert.equal(fixture.dismissed(), 0);
  const raised = { style: { zIndex: 2 } };
  fixture.document.querySelectorAll = () => [fixture.overlay, raised];
  key(fixture.document, 'Escape');
  assert.equal(fixture.dismissed(), 0);
  fixture.document.querySelectorAll = () => [fixture.overlay];
  assert.equal(key(fixture.document, 'Escape').defaultPrevented, true);
  assert.equal(fixture.dismissed(), 1);
  fixture.cleanup();
  key(fixture.document, 'Escape');
  assert.equal(fixture.dismissed(), 1);
  assert.equal(fixture.restored(), 1);
});

test('Tab and Shift+Tab keep focus in the dialog without interrupting ordinary input', () => {
  const fixture = modalFixture();
  const { document, controls } = fixture;
  assert.equal(document.activeElement, controls[0]);
  assert.equal(key(document, 'Tab').defaultPrevented, false);
  controls.at(-1).focus();
  assert.equal(key(document, 'Tab').defaultPrevented, true);
  assert.equal(document.activeElement, controls[0]);
  key(document, 'Tab', { shiftKey: true });
  assert.equal(document.activeElement, controls.at(-1));
  document.activeElement = {};
  key(document, 'Tab');
  assert.equal(document.activeElement, controls[0]);
  fixture.cleanup();
});

test('keyboard viewport changes are coalesced and subscriptions and frames are cleaned up', () => {
  const fixture = modalFixture();
  assert.equal(fixture.styles.get('--rb-modal-viewport-height'), '340px');
  assert.equal(fixture.styles.get('--rb-modal-viewport-top'), '24px');
  fixture.viewport.height = 280;
  fixture.viewport.dispatchEvent(new Event('resize'));
  fixture.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(fixture.pending(), 1);
  fixture.flush();
  assert.equal(fixture.styles.get('--rb-modal-viewport-height'), '280px');
  fixture.viewport.dispatchEvent(new Event('resize'));
  fixture.cleanup();
  assert.equal(fixture.pending(), 0);
  fixture.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(fixture.pending(), 0);
});
