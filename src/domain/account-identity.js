// Shape of the account id and session generation that the account cookie
// carries. Storage checks (backup verification) and the cookie codec share
// these, so a stored record always fits in a cookie that verifies.
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SESSION_GENERATION_PATTERN = /^\d{1,15}$/;

export const isAccountId = (value) => typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value);

/** Raw generation digits as they appear in a cookie. */
export const isSessionGenerationText = (text) => typeof text === 'string' && SESSION_GENERATION_PATTERN.test(text);

export const isSessionGeneration = (value) => Number.isSafeInteger(value) && isSessionGenerationText(String(value));
