import { t } from './i18n.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function relativeTime(timestamp, now) {
  const elapsed = now - timestamp;
  if (elapsed < MINUTE_MS) return { key: 'common.justNow' };
  if (elapsed < HOUR_MS) return { key: 'common.minutesAgo', n: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS) return { key: 'common.hoursAgo', n: Math.floor(elapsed / HOUR_MS) };
  return { key: 'common.daysAgo', n: Math.floor(elapsed / DAY_MS) };
}

export function formatRelativeTime(timestamp, now = Date.now()) {
  const { key, n } = relativeTime(timestamp, now);
  return t(key, n === undefined ? undefined : { n });
}
