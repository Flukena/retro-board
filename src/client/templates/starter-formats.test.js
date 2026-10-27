import test from 'node:test';
import assert from 'node:assert/strict';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { geometryErrorForBoard } from '../../domain/board-geometry.js';
import { STARTER_FORMAT, starterFormat, starterSlugs, starterTemplate, templatePath } from './starter-formats.js';

const COLUMN_COUNTS = Object.freeze({
  [STARTER_FORMAT.RETRO_LOOP]: 5, [STARTER_FORMAT.START_STOP_CONTINUE]: 3, [STARTER_FORMAT.MAD_SAD_GLAD]: 3, [STARTER_FORMAT.FOUR_LS]: 4,
});
const contains = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

test('each format lays out one valid zone per column; zones either nest or do not touch', () => {
  assert.deepEqual(starterSlugs().sort(), Object.keys(COLUMN_COUNTS).sort());
  for (const slug of starterSlugs()) {
    const { zones } = starterTemplate(slug);
    const frames = zones.filter((zone) => zones.some((other) => other !== zone && contains(zone, other)));
    assert.equal(zones.length - frames.length, COLUMN_COUNTS[slug], slug);
    assert.equal(geometryErrorForBoard(zones.map((zone, index) => ({ ...zone, id: `z${index}`, type: 'zone' }))), null, slug);
    for (const [index, a] of zones.entries()) {
      for (const b of zones.slice(index + 1)) assert.ok(apart(a, b) || contains(a, b) || contains(b, a), `${slug}: zones overlap`);
    }
  }
});

test('Retro Loop uses exactly the in-app Retro Loop layout', async () => {
  const { getTemplates } = await import('./builtin-templates.js');
  assert.deepEqual(starterTemplate(STARTER_FORMAT.RETRO_LOOP), getTemplates().retroLoop);
});

test('unknown slugs have no page and no layout', () => {
  for (const slug of ['nope', '__proto__', 'constructor', '']) {
    assert.equal(starterFormat(slug), null, slug);
    assert.equal(starterTemplate(slug), null, slug);
  }
  assert.equal(templatePath(STARTER_FORMAT.MAD_SAD_GLAD), '/templates/mad-sad-glad');
});

test('every format has its explanation, steps, column notes, prompts and zone titles in both languages', async () => {
  await withChromeModule('/src/client/templates/starter-formats.js', (formats, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const slug of formats.starterSlugs()) {
        const copy = formats.starterFormat(slug);
        const keys = [copy.nameKey, copy.headingKey, copy.ledeKey, copy.whenKey, ...copy.stepKeys,
          ...copy.columns.flatMap((column) => [column.zoneKey, column.descKey, ...column.promptKeys])];
        for (const key of keys) assert.notEqual(t(key), key, `${lang}: missing ${key}`);
        const titles = formats.starterTemplate(slug).zones.map((zone) => zone.title);
        for (const column of copy.columns) assert.ok(titles.includes(t(column.zoneKey)), `${lang} ${slug}: zone ${column.id}`);
      }
    }
  });
});

test('the in-app template list still offers only Retro Loop', async () => {
  const { getTemplates } = await import('./builtin-templates.js');
  assert.deepEqual(Object.keys(getTemplates()), ['retroLoop']);
});
