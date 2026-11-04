import { isActionDueDate } from '../../domain/action-item.js';

const ISO_DATE_LENGTH = 10;
const MS_PER_MINUTE = 60_000;
const DUE_DATE_FORMAT = Object.freeze({ day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Today's calendar date in the viewer's own time zone, as `YYYY-MM-DD`. */
export function localIsoDate(now = new Date()) {
  const offsetMs = now.getTimezoneOffset() * MS_PER_MINUTE;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, ISO_DATE_LENGTH);
}

/** Short, localized due date ("Nov 30"); empty when there is no valid date. */
export function formatActionDue(due, lang) {
  if (!isActionDueDate(due)) return '';
  return new Intl.DateTimeFormat(lang, DUE_DATE_FORMAT).format(new Date(`${due}T00:00:00Z`));
}

/** An open item whose due day is before today. */
export function isActionOverdue(row, today) {
  return !row.done && isActionDueDate(row.due) && row.due < today;
}
