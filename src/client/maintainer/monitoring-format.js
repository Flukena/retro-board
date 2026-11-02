import { t } from '../ui/i18n.js';

const BYTES_PER_MIB = 1024 * 1024;
const MIB_DECIMAL_PLACES = 1;

export const formatMib = bytes => t('maintainer.mib', {n:(bytes / BYTES_PER_MIB).toFixed(MIB_DECIMAL_PLACES)});

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const validTimestamp = value => Number.isSafeInteger(value) && value > 0;

export const formatRoomTime = value => validTimestamp(value)
  ? new Date(value).toLocaleString() : t('maintainer.timeUnknown');

export function formatRoomAge(createdAt, now) {
  if (!validTimestamp(createdAt) || !Number.isFinite(now) || createdAt > now) return t('maintainer.timeUnknown');
  const seconds = Math.floor((now - createdAt) / MILLISECONDS_PER_SECOND);
  const units = [['days', SECONDS_PER_DAY], ['hours', SECONDS_PER_HOUR], ['minutes', SECONDS_PER_MINUTE]];
  const [unit, divisor] = units.find(([, size]) => seconds >= size) ?? ['seconds', 1];
  return t(`maintainer.${unit}`, { n: Math.floor(seconds / divisor) });
}
