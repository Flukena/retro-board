import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSpacePan } from './use-space-pan.js';

test('space pan respects interactive controls, releases on blur and removes listeners', () => {
  const view = new EventTarget();
  const doc = { dialog: false, querySelector() { return this.dialog; } };
  const held = { current: false }, canvas = { current: { style: {} } }, interaction = { current: null };
  const detach = attachSpacePan(view, doc, held, canvas, interaction);
  const key = type => { const event = new Event(type, { cancelable: true }); event.code = 'Space'; view.dispatchEvent(event); return event; };
  doc.dialog = true;
  assert.equal(key('keydown').defaultPrevented, false);
  assert.equal(held.current, false);
  doc.dialog = false;
  assert.equal(key('keydown').defaultPrevented, true);
  assert.equal(held.current, true);
  assert.equal(canvas.current.style.cursor, 'grab');
  view.dispatchEvent(new Event('blur'));
  assert.equal(held.current, false);
  assert.equal(canvas.current.style.cursor, '');
  key('keydown'); interaction.current = { kind: 'pan' }; key('keyup');
  assert.equal(canvas.current.style.cursor, 'grabbing');
  detach(); key('keydown'); assert.equal(held.current, false);
});
