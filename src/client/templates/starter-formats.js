import { t } from '../ui/i18n.js';
import { getTemplates } from './builtin-templates.js';

// Retrospective formats offered on the public template pages. Each one opens a
// new board with its zones ready. Only Retro Loop is also in the in-app
// template list (the owner keeps that list to Retro Loop); its layout comes
// from that built-in template so the two never drift apart.

export const STARTER_FORMAT = Object.freeze({
  RETRO_LOOP: 'retro-loop',
  START_STOP_CONTINUE: 'start-stop-continue',
  MAD_SAD_GLAD: 'mad-sad-glad',
  FOUR_LS: '4ls-retrospective',
});

export const TEMPLATE_PATH_PREFIX = '/templates/';
export const templatePath = (slug) => `${TEMPLATE_PATH_PREFIX}${slug}`;

const STEP_COUNT = 5;
const PROMPTS_PER_COLUMN = 2;

const COLUMN_W_PX = 1140;
const COLUMN_H_PX = 1560;
const COLUMN_PITCH_PX = 1200;
const GRID_W_PX = 1200;
const GRID_H_PX = 1080;
const GRID_PITCH_X_PX = 1260;
const GRID_PITCH_Y_PX = 1140;

// Zone colours are palette indexes, as in the built-in templates.
const ZONE_COLOR = Object.freeze({ RED: 1, GREEN: 2, BLUE: 3, PURPLE: 4, ORANGE: 5 });

const columns = (colors) => colors.map((color, index) => ({
  color, x: index * COLUMN_PITCH_PX, y: 0, w: COLUMN_W_PX, h: COLUMN_H_PX,
}));
const grid = (colors) => colors.map((color, index) => ({
  color, x: (index % 2) * GRID_PITCH_X_PX, y: Math.floor(index / 2) * GRID_PITCH_Y_PX, w: GRID_W_PX, h: GRID_H_PX,
}));

const FORMATS = Object.freeze({
  [STARTER_FORMAT.RETRO_LOOP]: {
    key: 'loop', columnIds: ['prev', 'good', 'bad', 'try', 'next'],
    builtinKey: 'retroLoop', zoneKeyBase: 'tmpl.loop',
  },
  [STARTER_FORMAT.START_STOP_CONTINUE]: {
    key: 'ssc', columnIds: ['start', 'stop', 'continue'],
    layout: columns([ZONE_COLOR.GREEN, ZONE_COLOR.RED, ZONE_COLOR.BLUE]),
  },
  [STARTER_FORMAT.MAD_SAD_GLAD]: {
    key: 'msg', columnIds: ['mad', 'sad', 'glad'],
    layout: columns([ZONE_COLOR.RED, ZONE_COLOR.PURPLE, ZONE_COLOR.GREEN]),
  },
  [STARTER_FORMAT.FOUR_LS]: {
    key: '4ls', columnIds: ['liked', 'learned', 'lacked', 'longed'],
    layout: grid([ZONE_COLOR.RED, ZONE_COLOR.BLUE, ZONE_COLOR.ORANGE, ZONE_COLOR.PURPLE]),
  },
});

const range = (count) => Array.from({ length: count }, (_, index) => index + 1);

/** Copy keys for one format's page; null for an unknown slug. */
export function starterFormat(slug) {
  const format = Object.hasOwn(FORMATS, slug) ? FORMATS[slug] : null;
  if (!format) return null;
  const base = `tpl.${format.key}`;
  const zoneKeyBase = format.zoneKeyBase ?? `${base}.zone`;
  return {
    slug,
    path: templatePath(slug),
    nameKey: `${base}.name`,
    headingKey: `${base}.heading`,
    ledeKey: `${base}.lede`,
    whenKey: `${base}.when`,
    stepKeys: range(STEP_COUNT).map((n) => `${base}.step${n}`),
    columns: format.columnIds.map((id) => ({
      id,
      zoneKey: `${zoneKeyBase}.${id}`,
      descKey: `${base}.col.${id}`,
      promptKeys: range(PROMPTS_PER_COLUMN).map((n) => `${base}.prompt.${id}${n}`),
    })),
  };
}

export const starterSlugs = () => Object.keys(FORMATS);

/** The format as a template the board can place: zones titled in the current language. */
export function starterTemplate(slug) {
  const format = Object.hasOwn(FORMATS, slug) ? FORMATS[slug] : null;
  const copy = starterFormat(slug);
  if (!format || !copy) return null;
  if (format.builtinKey) return getTemplates()[format.builtinKey];
  return {
    name: t(copy.nameKey),
    zones: format.layout.map((zone, index) => ({ ...zone, title: t(copy.columns[index].zoneKey) })),
  };
}
