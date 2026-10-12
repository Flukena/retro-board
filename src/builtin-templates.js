import { t } from './i18n.js';

// Built-in templates are evaluated lazily so titles re-localize on lang change.
export const getTemplates = () => ({
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
