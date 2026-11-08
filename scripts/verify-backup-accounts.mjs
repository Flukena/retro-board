import {
  ACCOUNTS_DOC_NAME, ACCOUNT_KEY_PREFIX, EMAIL_KEY_PREFIX, SUB_KEY_PREFIX, emailKey, subKey,
} from '../src/server/account-store.js';
import { isAccountId, isSessionGeneration } from '../src/domain/account-identity.js';
import { isKnownPlan } from '../src/domain/plan-entitlements.js';

// Messages are fixed strings: account keys can carry email addresses.
const INVALID_RECORD = 'account record is invalid';
const UNREADABLE = 'accounts namespace cannot be read';
const UNKNOWN_KEY = 'unknown key in accounts namespace';
const DANGLING_SUB = 'sub index points to a missing account';
const DANGLING_EMAIL = 'email index points to a missing account';
const MISMATCHED_SUB = 'sub index points to an account with a different sub';
const MISMATCHED_EMAIL = 'email index points to an account with a different email';
const MISSING_SUB = 'account has no sub index';
const MISSING_EMAIL = 'account has no email index';
const INVALID_EMAIL_INDEX = 'email index is invalid';

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPlainRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (message) => { throw new Error(message); };
const isIdList = (value) => Array.isArray(value) && value.length > 0
  && value.every(isNonEmptyString) && new Set(value).size === value.length;
const subIds = (id) => [id];
const emailIds = (ids) => (isIdList(ids) ? ids : fail(INVALID_EMAIL_INDEX));

function isValidAccount(id, account) {
  return isPlainRecord(account)
    && account.id === id
    && isAccountId(id)
    && isNonEmptyString(account.googleSub)
    && isNonEmptyString(account.email)
    && typeof account.name === 'string'
    && isKnownPlan(account.plan)
    && (account.planGrantedAt === null || isFiniteNumber(account.planGrantedAt))
    && isSessionGeneration(account.sessionGeneration)
    && isFiniteNumber(account.createdAt);
}

function splitMetas(metas) {
  const accounts = new Map();
  const subIndex = new Map();
  const emailIndex = new Map();
  for (const [key, value] of metas) {
    if (key.startsWith(ACCOUNT_KEY_PREFIX)) accounts.set(key.slice(ACCOUNT_KEY_PREFIX.length), value);
    else if (key.startsWith(SUB_KEY_PREFIX)) subIndex.set(key, value);
    else if (key.startsWith(EMAIL_KEY_PREFIX)) emailIndex.set(key, value);
    else fail(UNKNOWN_KEY);
  }
  return { accounts, subIndex, emailIndex };
}

function checkIndexEntries(index, accounts, { idsOf, dangling, mismatched, matches }) {
  for (const [key, value] of index) {
    for (const id of idsOf(value)) {
      const account = accounts.get(id);
      if (!account) fail(dangling);
      if (!matches(key, account)) fail(mismatched);
    }
  }
}

function checkAccountsAreIndexed({ accounts, subIndex, emailIndex }) {
  for (const [id, account] of accounts) {
    if (subIndex.get(subKey(account.googleSub)) !== id) fail(MISSING_SUB);
    if (!(emailIndex.get(emailKey(account.email)) ?? []).includes(id)) fail(MISSING_EMAIL);
  }
}

/**
 * Read-only consistency check of the accounts namespace of a restored relay
 * LevelDB. Every account record must decode and have a valid shape. A `sub:`
 * index holds one id and an `email:` index a non-empty list of distinct ids;
 * each id must be an existing account that owns that key, and every account
 * must appear in both its `sub:` and its `email:` index.
 * Ids and generations must be ones the account cookie can carry.
 * A database without the namespace (a pre-accounts backup) verifies with 0.
 * @param {{ getMetas(docName: string): Promise<Map<string, unknown>> }} persistence y-leveldb persistence
 * @returns {Promise<{ accounts: number }>}
 */
export async function verifyBackupAccounts(persistence) {
  const metas = await persistence.getMetas(ACCOUNTS_DOC_NAME);
  // y-leveldb resolves null (after logging) when a stored value cannot be decoded.
  if (!(metas instanceof Map)) fail(UNREADABLE);
  const layout = splitMetas(metas);
  for (const [id, account] of layout.accounts) {
    if (!isValidAccount(id, account)) fail(INVALID_RECORD);
  }
  checkIndexEntries(layout.subIndex, layout.accounts, {
    idsOf: subIds,
    dangling: DANGLING_SUB,
    mismatched: MISMATCHED_SUB,
    matches: (key, account) => subKey(account.googleSub) === key,
  });
  checkIndexEntries(layout.emailIndex, layout.accounts, {
    idsOf: emailIds,
    dangling: DANGLING_EMAIL,
    mismatched: MISMATCHED_EMAIL,
    matches: (key, account) => emailKey(account.email) === key,
  });
  checkAccountsAreIndexed(layout);
  return { accounts: layout.accounts.size };
}
