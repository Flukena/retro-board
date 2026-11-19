import { t } from '../ui/i18n.js';

const FLATTENED_IDS_SHOWN_MAX = 5;
const NOTICE_SEPARATOR = ' · ';

/** First few item ids, then "+N" for the rest. */
export const flattenedIdList = (ids) => {
  const shown = ids.slice(0, FLATTENED_IDS_SHOWN_MAX).join(', ');
  return ids.length > FLATTENED_IDS_SHOWN_MAX ? `${shown}, +${ids.length - FLATTENED_IDS_SHOWN_MAX}` : shown;
};

/** The success toast for a JSON/ZIP backup: names flattened images and repaired geometry when either applies. */
export const backupDoneNotice = ({ fileName, geometryRepairs, flattenedImageIds = [] }) => {
  const { positions, zoneDimensions } = geometryRepairs;
  const parts = [];
  if (flattenedImageIds.length > 0) {
    parts.push(t('export.flattened', { file: fileName, count: flattenedImageIds.length, ids: flattenedIdList(flattenedImageIds) }));
  }
  if (positions || zoneDimensions) parts.push(t('export.repaired', { file: fileName, positions, zones: zoneDimensions }));
  return { msg: parts.length > 0 ? parts.join(NOTICE_SEPARATOR) : t('export.done', { file: fileName }), type: 'info' };
};
