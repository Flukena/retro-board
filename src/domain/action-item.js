// Historical sticky fields retained for lossless room imports and backups.
export const ACTION_FIELD = Object.freeze({
  FLAG: 'actionItem',
  OWNER: 'actionOwner',
  DUE: 'actionDue',
  DONE: 'actionDone',
});
export const ACTION_OWNER_MAX_LENGTH = 80;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_LENGTH = 10;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (message) => {
  throw new Error(message);
};

/** True for a real calendar date written as `YYYY-MM-DD`. */
export const isActionDueDate = (value) => {
  const match = typeof value === 'string' ? ISO_DATE_RE.exec(value) : null;
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, ISO_DATE_LENGTH) === value;
};

const readFlag = (item, key, label) => {
  if (!hasOwn(item, key)) return undefined;
  if (typeof item[key] !== 'boolean') fail(`${label} ${key} must be a boolean`);
  return item[key];
};

const readOwner = (item, label) => {
  if (!hasOwn(item, ACTION_FIELD.OWNER)) return undefined;
  const owner = item[ACTION_FIELD.OWNER];
  if (typeof owner !== 'string') fail(`${label} actionOwner must be a string`);
  if (owner.length > ACTION_OWNER_MAX_LENGTH) fail(`${label} actionOwner is too long (max ${ACTION_OWNER_MAX_LENGTH})`);
  return owner;
};

const readDue = (item, label) => {
  if (!hasOwn(item, ACTION_FIELD.DUE)) return undefined;
  const due = item[ACTION_FIELD.DUE];
  if (due !== '' && !isActionDueDate(due)) fail(`${label} actionDue must be an empty string or YYYY-MM-DD`);
  return due;
};

/**
 * Strict reader for the action fields of a sticky. Missing fields stay
 * missing; explicit invalid values are rejected rather than repaired.
 */
export const normalizeActionFields = (item, label) => {
  const fields = {
    [ACTION_FIELD.FLAG]: readFlag(item, ACTION_FIELD.FLAG, label),
    [ACTION_FIELD.OWNER]: readOwner(item, label),
    [ACTION_FIELD.DUE]: readDue(item, label),
    [ACTION_FIELD.DONE]: readFlag(item, ACTION_FIELD.DONE, label),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
};
