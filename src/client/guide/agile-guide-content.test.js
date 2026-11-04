import test from 'node:test';
import assert from 'node:assert/strict';
import { setLang, t } from '../ui/i18n.js';
import { starterFormat } from '../templates/starter-formats.js';
import { AGILE_GUIDE_SECTIONS, AGILE_SECTION, AGILE_SOURCE_URL, GUIDE_BLOCK, agileGuideKeys } from './agile-guide-content.js';

const blocksOf = (id, kind) => AGILE_GUIDE_SECTIONS.find((section) => section.id === id).blocks.filter((block) => block.kind === kind);
const TEMPLATE_PATH = /^\/templates\/(.+)$/;

test('the guide runs Agile, Scrum, roles, events, artifacts, practices, retro, mistakes, then sources', () => {
  assert.deepEqual(AGILE_GUIDE_SECTIONS.map((section) => section.id), [
    AGILE_SECTION.AGILE, AGILE_SECTION.SCRUM, AGILE_SECTION.ROLES, AGILE_SECTION.EVENTS, AGILE_SECTION.ARTIFACTS,
    AGILE_SECTION.PRACTICES, AGILE_SECTION.RETRO, AGILE_SECTION.MISTAKES, AGILE_SECTION.SOURCES,
  ]);
  const anchors = AGILE_GUIDE_SECTIONS.map((section) => section.anchorId);
  assert.equal(new Set(anchors).size, anchors.length);
});

test('every word the guide shows has Thai and English text', () => {
  const keys = agileGuideKeys();
  assert.equal(new Set(keys).size, keys.length, 'no key is shown twice');
  for (const lang of ['th', 'en']) {
    setLang(lang);
    const missing = keys.filter((key) => t(key) === key);
    assert.deepEqual(missing, [], lang);
  }
  setLang('en');
});

test('the Agile Manifesto has four values and Scrum three pillars and five values (Scrum Guide 2020)', () => {
  const [values] = blocksOf(AGILE_SECTION.AGILE, GUIDE_BLOCK.TABLE);
  assert.equal(values.rows.length, 4);
  assert.deepEqual(blocksOf(AGILE_SECTION.SCRUM, GUIDE_BLOCK.ORDERED)[0].keys.length, 3);
  assert.deepEqual(blocksOf(AGILE_SECTION.SCRUM, GUIDE_BLOCK.BULLETS)[0].keys.length, 5);
});

test('the events table lists the four timeboxed events in Scrum Guide order', () => {
  const [events] = blocksOf(AGILE_SECTION.EVENTS, GUIDE_BLOCK.TABLE);
  assert.deepEqual(events.rows.map((row) => row.id), ['planning', 'daily', 'review', 'retro']);
  for (const row of events.rows) assert.equal(row.cellKeys.length, events.columnKeys.length, row.id);
});

test('the retro steps follow the six meeting phases and formats link to existing templates', () => {
  assert.equal(blocksOf(AGILE_SECTION.RETRO, GUIDE_BLOCK.ORDERED)[0].keys.length, 6);
  const [formats] = blocksOf(AGILE_SECTION.RETRO, GUIDE_BLOCK.TABLE);
  const linked = formats.rows.filter((row) => row.href);
  assert.equal(linked.length, 4);
  for (const row of linked) assert.ok(starterFormat(row.href.match(TEMPLATE_PATH)[1]), row.href);
});

test('sources link the Scrum Guide and both Agile Manifesto pages', () => {
  const [links] = blocksOf(AGILE_SECTION.SOURCES, GUIDE_BLOCK.LINKS);
  assert.deepEqual(links.links.map((link) => link.href), [
    'https://scrumguides.org/scrum-guide.html', 'https://agilemanifesto.org/', 'https://agilemanifesto.org/principles.html',
  ]);
  assert.deepEqual(Object.values(AGILE_SOURCE_URL).sort(), links.links.map((link) => link.href).sort());
});
