import { t } from '../ui/i18n.js';

/** The tab title for a named page: "<title> · RetroRoom", or the app name alone. */
export const documentTitleFor = (title) => (title ? `${title} · ${t('app.title')}` : t('app.title'));
