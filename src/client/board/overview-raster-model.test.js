import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewRasterModel, overviewPaintRuns } from './overview-raster-model.js';

const items = () => Array.from({ length: 64 }, (_, n) => ({ id: `note-${n}`, type: 'sticky', x: (n % 8) * 330,
  y: Math.floor(n / 8) * 280, w: 280, h: 240, text: `Note ${n}`, authorId: 'owner' }));
const options = () => ({ contexts: new Map(), winners: new Map(), allRevealed: false, userId: 'viewer', hiddenText: 'Hidden', dpr: 3 });

test('raster rows redact non-owner private text with nested reveal overrides', () => {
  const board = items(); board[0] = { ...board[0], private: true, text: 'DO NOT RASTER' };
  const model = overviewRasterModel(board, options());
  assert.equal(model.rows[0].text, 'Hidden');
  assert.ok(!JSON.stringify(model.rows).includes('DO NOT RASTER'));
  const revealed = options(); revealed.contexts.set(board[0].id, { revealed: true });
  assert.equal(overviewRasterModel(board, revealed).rows[0].text, 'DO NOT RASTER');
  assert.equal(overviewRasterModel(board, { ...options(), userId: 'owner' }).rows[0].text, 'DO NOT RASTER');
  assert.equal(board[0].text, 'DO NOT RASTER');
});

test('overlap, large cards and winners retain native text instead of changing paint order', () => {
  const board = items(); board[1] = { ...board[1], x: board[0].x, y: board[0].y };
  board[2] = { ...board[2], w: 600 };
  const config = options(); config.winners.set(board[10].id, 1);
  const model = overviewRasterModel(board, config);
  for (const id of [board[0].id, board[1].id, board[2].id, board[10].id]) assert.equal(model.ids.has(id), false);
  assert.ok(model.ids.has(board[63].id));
});

test('paint runs preserve card/image/zone order and stable group keys independently of culling', () => {
  const board = items();
  const image = { id: 'image', type: 'image' }, zone = { id: 'zone', type: 'zone' };
  const runs = overviewPaintRuns([zone, ...board.slice(0, 32), image, ...board.slice(32)]);
  assert.deepEqual(runs.map(run => [run.key, run.raster, run.items.length]), [['zone', false, 1], ['note-0', true, 32], ['image', false, 1], ['note-32', true, 32]]);
  assert.deepEqual(runs.flatMap(run => run.items), [zone, ...board.slice(0, 32), image, ...board.slice(32)]);
});

test('bitmap allocation is bounded and sparse huge boards keep native rendering', () => {
  const board = items(), model = overviewRasterModel(board, options());
  assert.ok(model.width <= 4096 && model.height <= 4096 && model.width * model.height <= 8_388_608);
  assert.equal(overviewRasterModel(board.slice(0, 10), options()), null);
  board[0] = { ...board[0], x: -1_000_000, y: -1_000_000 };
  assert.equal(overviewRasterModel(board, options()), null);
});

test('large obstacles are indexed without unbounded spatial buckets', () => {
  const board = items();
  board.push({ id: 'image', type: 'image', x: -100, y: -100, w: 50000, h: 50000 });
  assert.equal(overviewRasterModel(board, options()), null);
});


test('each paint run obeys its share of the total bitmap budget', () => {
  const model = overviewRasterModel(items(), { ...options(), maxPixels: 100000 });
  assert.ok(model && model.width * model.height <= 100000);
  assert.equal(overviewRasterModel(items(), { ...options(), maxPixels: 10000 }), null);
});
