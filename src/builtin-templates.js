import { t } from './i18n.js';

// Built-in templates are evaluated lazily so titles re-localize on lang change.
export const getTemplates = () => ({
  retro3: {
    name: t('tmpl.retro3.name'),
    zones: [
      { title: t('tmpl.retro3.well'),    color: 2, x: 0,    y: 0, w: 1140, h: 1560 },
      { title: t('tmpl.retro3.improve'), color: 1, x: 1200, y: 0, w: 1140, h: 1560 },
      { title: t('tmpl.retro3.action'),  color: 3, x: 2400, y: 0, w: 1140, h: 1560 },
    ],
  },
  ssc: {
    name: t('tmpl.ssc.name'),
    zones: [
      { title: '▶️ Start',    color: 2, x: 0,    y: 0, w: 1140, h: 1560 },
      { title: '⏹ Stop',     color: 1, x: 1200, y: 0, w: 1140, h: 1560 },
      { title: '⏩ Continue', color: 3, x: 2400, y: 0, w: 1140, h: 1560 },
    ],
  },
  fourLs: {
    name: t('tmpl.4ls.name'),
    zones: [
      { title: '❤️ Liked',      color: 1, x: 0,    y: 0,    w: 1200, h: 1080 },
      { title: '🧠 Learned',    color: 3, x: 1260, y: 0,    w: 1200, h: 1080 },
      { title: '🫥 Lacked',     color: 5, x: 0,    y: 1140, w: 1200, h: 1080 },
      { title: '💭 Longed for', color: 4, x: 1260, y: 1140, w: 1200, h: 1080 },
    ],
  },
  sailboat: {
    name: t('tmpl.sailboat.name'),
    zones: [
      { title: t('tmpl.sailboat.wind'),   color: 2, x: 0,    y: 0,    w: 1200, h: 1080 },
      { title: t('tmpl.sailboat.anchor'), color: 1, x: 1260, y: 0,    w: 1200, h: 1080 },
      { title: t('tmpl.sailboat.rocks'),  color: 5, x: 0,    y: 1140, w: 1200, h: 1080 },
      { title: t('tmpl.sailboat.island'), color: 3, x: 1260, y: 1140, w: 1200, h: 1080 },
    ],
  },
  retroLoop: {
    name: t('tmpl.loop.name'),
    zones: [
      // Outer wrapper — drag its title bar to move the whole template as one.
      { title: t('tmpl.loop.wrapper'), color: 3, x: 0,    y: 0,   w: 6219, h: 2316 },
      { title: t('tmpl.loop.prev'),    color: 0, x: 171,  y: 456, w: 927,  h: 1440 },
      { title: t('tmpl.loop.good'),    color: 2, x: 1191, y: 351, w: 1140, h: 1560 },
      { title: t('tmpl.loop.bad'),     color: 1, x: 2391, y: 351, w: 1140, h: 1560 },
      { title: t('tmpl.loop.try'),     color: 4, x: 3591, y: 351, w: 1140, h: 1560 },
      { title: t('tmpl.loop.next'),    color: 5, x: 4848, y: 417, w: 1086, h: 1464 },
    ],
  },
});
