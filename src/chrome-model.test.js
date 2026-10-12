import test from 'node:test';
import assert from 'node:assert/strict';
import { templateRows, followBannerModel } from './chrome-model.js';
import { DOCK_TILE_INDEX, PALETTE } from './palette.js';
import { timerDockModel } from './vote-timing.js';

test('template rows preserve source order, names and custom zone counts', () => {
  assert.deepEqual(templateRows({ retro: { name: 'Retro' } }, [
    { id: 'mine', name: 'Mine', zones: [{}, {}] },
  ]), {
    builtin: [{ id: 'retro', name: 'Retro' }],
    custom: [{ id: 'mine', name: 'Mine', zoneCount: 2 }],
  });
  assert.deepEqual(templateRows({}, []).custom, []);
});

test('dock palette mapping is frozen and resolves every tool by name', () => {
  assert.ok(Object.isFrozen(DOCK_TILE_INDEX));
  const expected = { templates: 'purple', select: 'orange', text: 'yellow', zone: 'green', image: 'blue' };
  for (const [tool, name] of Object.entries(expected)) {
    assert.equal(PALETTE[DOCK_TILE_INDEX[tool]].name, name);
  }
});

test('timer model clamps expired time and respects the strict urgent boundary', () => {
  const zone = { id: 'z', title: 'Vote', voteTimer: { endsAt: 40000, voteLimit: 3 } };
  assert.equal(timerDockModel(zone, 10000).urgent, false);
  assert.equal(timerDockModel(zone, 10001).urgent, true);
  assert.equal(timerDockModel(zone, 40001).remainingMs, 0);
  assert.equal(timerDockModel(zone, 40001).label, '00:00');
  assert.equal(timerDockModel(zone, 10000).label, '00:30');
  const open = timerDockModel({ ...zone, voteTimer: {} }, 10000);
  assert.equal(open.remainingMs, null);
  assert.equal(open.urgent, false);
});

test('follow model preserves name precedence and shared default name', () => {
  assert.equal(followBannerModel(null, {}, {}, false).name, 'Guest');
  assert.equal(followBannerModel(null, { name: 'Live' }, { name: 'Cached' }, true).name, 'Live');
  assert.equal(followBannerModel(null, {}, { name: 'Cached' }, false).name, 'Cached');
  assert.equal(followBannerModel(null, {}, {}, true).waiting, true);
});
