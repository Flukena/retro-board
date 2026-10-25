import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwnerZone } from './board-ownership.js';
import { getTemplates } from '../client/templates/builtin-templates.js';

test('public zone creation provides room for multiple cards while private drawing keeps its minimum', async () => {
  const { publicZoneCreationSize } = await import('./public-zone-layout.js');
  assert.deepEqual(publicZoneCreationSize('public', 20, 30), { w: 1200, h: 1080 });
  assert.deepEqual(publicZoneCreationSize('private', 20, 30), { w: 240, h: 200 });
  assert.deepEqual(publicZoneCreationSize('public', 1800, 1600), { w: 1800, h: 1600 });
});

test('larger layout expands zone area fourfold and preserves card size, nesting and separate blocks', async () => {
  const { enlargedZoneLayoutEntries } = await import('./public-zone-layout.js');
  const items = [
    { id: 'outer', type: 'zone', x: -100, y: 200, w: 1000, h: 800 },
    { id: 'inner', type: 'zone', x: 0, y: 300, w: 400, h: 500, parentZoneId: 'outer' },
    { id: 'note', type: 'sticky', x: 50, y: 400, w: 200, h: 180, parentZoneId: 'inner' },
    { id: 'second', type: 'zone', x: 2000, y: 200, w: 600, h: 800 },
  ];
  const entries = enlargedZoneLayoutEntries(items);
  const patches = new Map(entries.map(entry => [entry.id, entry.patch]));
  const larger = items.map(item => ({ ...item, ...patches.get(item.id) }));
  assert.deepEqual(larger[0], { ...items[0], w: 2000, h: 1600 });
  assert.deepEqual(larger[1], { ...items[1], x: 100, y: 400, w: 800, h: 1000 });
  assert.deepEqual(larger[2], { ...items[2], x: 300, y: 690 });
  assert.equal(resolveOwnerZone(larger[2], larger).id, 'inner');
  assert.ok(larger[3].x > larger[0].x + larger[0].w);
  assert.equal(items[0].w, 1000);
  assert.ok(entries.every(entry => Object.keys(entry.patch).every(key => ['x', 'y', 'w', 'h'].includes(key))));
});

test('enlargement rejects geometry that would exceed canonical bounds without partial patches', async () => {
  const { enlargedZoneLayoutEntries } = await import('./public-zone-layout.js');
  assert.throws(() => enlargedZoneLayoutEntries([
    { id: 'huge', type: 'zone', x: 0, y: 0, w: 100000, h: 1080 },
  ]), /dimensions|width/);
  assert.deepEqual(enlargedZoneLayoutEntries([]), []);
});

test('new Retro Loop columns have at least twice the previous width and height', () => {
  const template = getTemplates().retroLoop;
  assert.ok(template.zones[0].w >= 12438);
  assert.ok(template.zones[0].h >= 4632);
  for (const zone of template.zones.slice(1)) {
    assert.ok(zone.w >= 1854);
    assert.ok(zone.h >= 2880);
  }
});
