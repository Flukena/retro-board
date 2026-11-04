import { STARTER_FORMAT, templatePath } from '../templates/starter-formats.js';

// Agile & Scrum reader guide: section order and the shape of each section.
// All wording lives in i18n.js under `agileGuide.*`; this module only names the keys.

export const AGILE_SECTION = Object.freeze({
  AGILE: 'agile', SCRUM: 'scrum', ROLES: 'roles', EVENTS: 'events', ARTIFACTS: 'artifacts',
  PRACTICES: 'practices', RETRO: 'retro', MISTAKES: 'mistakes', SOURCES: 'sources',
});

export const GUIDE_BLOCK = Object.freeze({
  PARAGRAPH: 'paragraph', ORDERED: 'ordered', BULLETS: 'bullets', SUBHEADING: 'subheading', TABLE: 'table', LINKS: 'links',
});

// Primary sources the facts on the page were checked against.
export const AGILE_SOURCE_URL = Object.freeze({
  SCRUM_GUIDE: 'https://scrumguides.org/scrum-guide.html',
  MANIFESTO: 'https://agilemanifesto.org/',
  PRINCIPLES: 'https://agilemanifesto.org/principles.html',
});

const AGILE_VALUE_COUNT = 4;
const PRINCIPLE_GROUP_COUNT = 4;
const PILLAR_COUNT = 3;
const SCRUM_VALUE_COUNT = 5;
const RETRO_STEP_COUNT = 6;

const key = (section, part) => `agileGuide.${section}.${part}`;
const ids = (base, count) => Array.from({ length: count }, (_, index) => `${base}${index + 1}`);
const numbered = (section, base, count) => ids(base, count).map((id) => key(section, id));
const paragraph = (section, part) => ({ kind: GUIDE_BLOCK.PARAGRAPH, key: key(section, part) });
const list = (kind, keys) => ({ kind, keys });

/** A table whose row cells are `agileGuide.<section>.<row>.<field>`; rows may override a cell key or add a link. */
const table = (section, columns, rows, fields) => ({
  kind: GUIDE_BLOCK.TABLE,
  columnKeys: columns.map((column) => key(section, `col.${column}`)),
  rows: rows.map((row) => {
    const { id, nameKey = null, href = null } = typeof row === 'string' ? { id: row } : row;
    const cellKeys = fields.map((field) => key(section, `${id}.${field}`));
    return { id, cellKeys: nameKey ? [nameKey, ...cellKeys] : cellKeys, href };
  }),
});

const S = AGILE_SECTION;

const RETRO_FORMAT_ROWS = Object.freeze([
  { id: 'ssc', nameKey: 'tpl.ssc.name', href: templatePath(STARTER_FORMAT.START_STOP_CONTINUE) },
  { id: 'loop', nameKey: 'tpl.loop.name', href: templatePath(STARTER_FORMAT.RETRO_LOOP) },
  { id: 'fourLs', nameKey: 'tpl.4ls.name', href: templatePath(STARTER_FORMAT.FOUR_LS) },
  { id: 'msg', nameKey: 'tpl.msg.name', href: templatePath(STARTER_FORMAT.MAD_SAD_GLAD) },
  { id: 'sailboat', nameKey: key(S.RETRO, 'sailboat.name') },
]);

export const AGILE_GUIDE_SECTIONS = Object.freeze([
  { id: S.AGILE, blocks: [
    paragraph(S.AGILE, 'intro'),
    table(S.AGILE, ['more', 'less'], ids('value', AGILE_VALUE_COUNT), ['more', 'less']),
    paragraph(S.AGILE, 'principlesIntro'),
    list(GUIDE_BLOCK.BULLETS, numbered(S.AGILE, 'principle', PRINCIPLE_GROUP_COUNT)),
  ] },
  { id: S.SCRUM, blocks: [
    paragraph(S.SCRUM, 'intro'),
    paragraph(S.SCRUM, 'pillarsIntro'),
    list(GUIDE_BLOCK.ORDERED, numbered(S.SCRUM, 'pillar', PILLAR_COUNT)),
    paragraph(S.SCRUM, 'valuesIntro'),
    list(GUIDE_BLOCK.BULLETS, numbered(S.SCRUM, 'value', SCRUM_VALUE_COUNT)),
  ] },
  { id: S.ROLES, blocks: [
    paragraph(S.ROLES, 'intro'),
    table(S.ROLES, ['role', 'owns', 'work', 'notJob'], ['po', 'sm', 'dev'], ['name', 'owns', 'work', 'notJob']),
    paragraph(S.ROLES, 'note'),
  ] },
  { id: S.EVENTS, blocks: [
    paragraph(S.EVENTS, 'intro'),
    table(S.EVENTS, ['event', 'timebox', 'purpose'], ['planning', 'daily', 'review', 'retro'], ['name', 'timebox', 'purpose']),
    paragraph(S.EVENTS, 'note'),
  ] },
  { id: S.ARTIFACTS, blocks: [
    paragraph(S.ARTIFACTS, 'intro'),
    table(S.ARTIFACTS, ['artifact', 'what', 'commitment', 'meaning'], ['productBacklog', 'sprintBacklog', 'increment'],
      ['name', 'what', 'commitment', 'meaning']),
    paragraph(S.ARTIFACTS, 'note'),
  ] },
  { id: S.PRACTICES, blocks: [
    paragraph(S.PRACTICES, 'intro'),
    table(S.PRACTICES, ['practice', 'what', 'when'], ['story', 'invest', 'points', 'poker', 'velocity', 'burndown', 'kanban'],
      ['name', 'what', 'when']),
  ] },
  { id: S.RETRO, blocks: [
    paragraph(S.RETRO, 'intro'),
    list(GUIDE_BLOCK.ORDERED, numbered(S.RETRO, 'step', RETRO_STEP_COUNT)),
    { kind: GUIDE_BLOCK.SUBHEADING, key: key(S.RETRO, 'formatsTitle') },
    table(S.RETRO, ['format', 'columns', 'fit'], RETRO_FORMAT_ROWS, ['columns', 'fit']),
  ] },
  { id: S.MISTAKES, blocks: [
    paragraph(S.MISTAKES, 'intro'),
    table(S.MISTAKES, ['symptom', 'problem', 'fix'], ['daily', 'noChange', 'velocity', 'noGoal', 'carryOver', 'manyPo'],
      ['symptom', 'problem', 'fix']),
  ] },
  { id: S.SOURCES, blocks: [
    paragraph(S.SOURCES, 'intro'),
    { kind: GUIDE_BLOCK.LINKS, links: [
      { href: AGILE_SOURCE_URL.SCRUM_GUIDE, key: key(S.SOURCES, 'scrumGuide') },
      { href: AGILE_SOURCE_URL.MANIFESTO, key: key(S.SOURCES, 'manifesto') },
      { href: AGILE_SOURCE_URL.PRINCIPLES, key: key(S.SOURCES, 'principles') },
    ] },
    paragraph(S.SOURCES, 'note'),
  ] },
].map((section) => Object.freeze({ ...section, titleKey: key(section.id, 'title'), anchorId: `agile-guide-${section.id}` })));

const BLOCK_KEYS = Object.freeze({
  [GUIDE_BLOCK.PARAGRAPH]: (block) => [block.key],
  [GUIDE_BLOCK.SUBHEADING]: (block) => [block.key],
  [GUIDE_BLOCK.ORDERED]: (block) => block.keys,
  [GUIDE_BLOCK.BULLETS]: (block) => block.keys,
  [GUIDE_BLOCK.TABLE]: (block) => [...block.columnKeys, ...block.rows.flatMap((row) => row.cellKeys)],
  [GUIDE_BLOCK.LINKS]: (block) => block.links.map((link) => link.key),
});

/** Every i18n key the guide sections render, for the coverage test. */
export const agileGuideKeys = () => AGILE_GUIDE_SECTIONS.flatMap((section) => [
  section.titleKey, ...section.blocks.flatMap((block) => BLOCK_KEYS[block.kind](block)),
]);
