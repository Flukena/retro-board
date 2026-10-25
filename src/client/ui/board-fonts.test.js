import test from 'node:test';
import assert from 'node:assert/strict';
import { warmBoardFonts } from './board-fonts.js';

const VALUES = { '--font-ui': '"Sarabun", system-ui', '--font-display': '"Mitr", sans-serif', '--sticky-vote-font-weight': '700' };
function fixture(load) {
  return { documentElement: {}, defaultView: { getComputedStyle: () => ({ getPropertyValue: name => VALUES[name] || '' }) }, fonts: { load } };
}
test('the board loads the actual UI and native vote fonts before a zoom first reveals full cards', async () => {
  const requests = [];
  await warmBoardFonts(fixture((font, text) => { requests.push({ font, text }); return Promise.resolve([]); }));
  assert.equal(requests.length, 2);
  assert.match(requests[0].font, /^normal \d+px "Sarabun"$/);
  assert.match(requests[1].font, /^700 \d+px "Mitr"$/);
  for (const request of requests) {
    assert.match(request.text, /[A-Za-z]/); assert.match(request.text, /[ก-๙]/); assert.match(request.text, /[0-9]/);
  }
});
test('missing APIs or unavailable font downloads preserve the normal system-font fallback', async () => {
  assert.deepEqual(await warmBoardFonts({}), []);
  const results = await warmBoardFonts(fixture(() => Promise.reject(new Error('Font unavailable'))));
  assert.equal(results.length, 2); assert.ok(results.every(result => result.status === 'rejected'));
});

test('font warmup waits for external stylesheets before querying their font faces', async () => {
  const requests = [], document = fixture(font => { requests.push(font); return Promise.resolve([]); });
  let loaded;
  document.readyState = 'interactive';
  document.defaultView.addEventListener = (name, listener, options) => {
    assert.equal(name, 'load'); assert.equal(options.once, true); loaded = listener;
  };
  const pending = warmBoardFonts(document);
  assert.deepEqual(requests, []);
  loaded(); await pending;
  assert.equal(requests.length, 2);
});
