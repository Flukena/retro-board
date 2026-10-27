import { t } from '../ui/i18n.js';

const BYTES_PER_MIB = 1024 * 1024;
const MIB_DECIMAL_PLACES = 1;

export const formatMib = bytes => t('maintainer.mib', {n:(bytes / BYTES_PER_MIB).toFixed(MIB_DECIMAL_PLACES)});
