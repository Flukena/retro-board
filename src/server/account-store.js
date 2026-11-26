import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { PLAN, isKnownPlan } from '../domain/plan-entitlements.js';
import { STORAGE_FAILURE_CODE, durableMetaBatch } from './relay-storage.js';
import { updateSavedHandles } from './saved-boards.js';

// Leading NUL keeps the accounts document out of every room/handle namespace.
// Accounts are meta-only (no Yjs updates), so getAllDocNames never lists it.
export const ACCOUNTS_DOC_NAME = '\u0000accounts';
export const ACCOUNT_STORAGE_FAILURE_EVENT = 'storage-failure';
const ACCOUNT_STORE_UNAVAILABLE_CODE = 'ACCOUNT_STORE_UNAVAILABLE';
export const DATABASE_CAPACITY_CODE = 'DATABASE_CAPACITY';
const UNKNOWN_PLAN_CODE = 'UNKNOWN_PLAN';
const ACCOUNT_STORE_UNAVAILABLE_MESSAGE = 'account store unavailable';
const DATABASE_CAPACITY_MESSAGE = 'database capacity reached';
const UNKNOWN_PLAN_MESSAGE = 'unknown plan';
const INVALID_PROFILE_MESSAGE = 'Google profile needs a sub and an email';
const ACCOUNT_ID_BYTES = 16;
const ACCOUNT_ID_ENCODING = 'base64url';
const INITIAL_SESSION_GENERATION = 0;
const SESSION_GENERATION_STEP = 1;
const MISSING_NAME = '';
export const ACCOUNT_KEY_PREFIX = 'acct:';
export const SUB_KEY_PREFIX = 'sub:';
export const EMAIL_KEY_PREFIX = 'email:';

const codedError = (message, code) => Object.assign(new Error(message), { code });
const unavailableError = () => codedError(ACCOUNT_STORE_UNAVAILABLE_MESSAGE, ACCOUNT_STORE_UNAVAILABLE_CODE);
const defaultRandomId = () => randomBytes(ACCOUNT_ID_BYTES).toString(ACCOUNT_ID_ENCODING);
const ignoreRejection = () => {};

export const accountKey = (id) => `${ACCOUNT_KEY_PREFIX}${id}`;
export const subKey = (sub) => `${SUB_KEY_PREFIX}${sub}`;
export const emailKey = (email) => `${EMAIL_KEY_PREFIX}${email.toLowerCase()}`;
const put = (key, value) => ({ type: 'put', key, value });
const del = (key) => ({ type: 'del', key });
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const byCreation = (left, right) => left.createdAt - right.createdAt;

function googleProfile({ sub, email, name }) {
  if (!isNonEmptyString(sub) || !isNonEmptyString(email)) throw new TypeError(INVALID_PROFILE_MESSAGE);
  return { sub, email, name: typeof name === 'string' ? name : MISSING_NAME };
}

/**
 * @typedef {object} Account
 * @property {string} id
 * @property {string} googleSub identity key; email is only an index
 * @property {string} email
 * @property {string} name '' when Google omits it
 * @property {string} plan
 * @property {number|null} planGrantedAt ms
 * @property {number} sessionGeneration integer >= 0
 * @property {number} createdAt ms
 */

/**
 * Durable account records in the relay's LevelDB, as meta keys of one doc:
 * `acct:<id>` -> Account, `sub:<googleSub>` -> id, `email:<lower-cased>` -> ids.
 * Two Google identities can share an email, so the email index lists every
 * account that holds it; lookups return them oldest account first.
 * Mutations run one at a time; each logical change is one fsynced batch.
 * A STORAGE_FAILURE is fatal: it is emitted once as 'storage-failure' and every
 * later mutation rejects ACCOUNT_STORE_UNAVAILABLE. Other rejections (capacity,
 * unknown plan, bad input) only fail their own call.
 */
export class AccountStore extends EventEmitter {
  #ldb;
  #getMeta;
  #hasCapacity;
  #now;
  #randomId;
  #chain = Promise.resolve();
  #pending = 0;
  #stopped = false;
  #failure = null;

  constructor({ ldb, getMeta, hasCapacity, now = Date.now, randomId = defaultRandomId }) {
    super();
    this.#ldb = ldb;
    this.#getMeta = getMeta;
    this.#hasCapacity = hasCapacity;
    this.#now = now;
    this.#randomId = randomId;
  }

  get pendingOperations() { return this.#pending; }

  /** @returns {Promise<Account|null>} */
  get(id) { return this.#read(accountKey(id)); }

  /** @returns {Promise<Account[]>} oldest first; [] when none */
  async findAllByEmail(email) {
    const accounts = await Promise.all((await this.#emailIds(email)).map((id) => this.get(id)));
    // A delete can land between the index read and the record reads.
    return accounts.filter(Boolean).sort(byCreation);
  }

  /** @returns {Promise<Account>} */
  upsertFromGoogle(profile) { return this.#enqueue(() => this.#upsert(googleProfile(profile))); }

  /** @returns {Promise<Account|null>} */
  setPlan(id, plan) { return this.#enqueue(() => this.#setPlan(id, plan)); }

  /**
   * With `expectedGeneration`, an account whose generation has moved on is left
   * unchanged and resolves null, the same as a missing one.
   * @returns {Promise<Account|null>}
   */
  bumpSessionGeneration(id, { expectedGeneration } = {}) {
    return this.#enqueue(() => this.#update(id, (account) => ({
      sessionGeneration: account.sessionGeneration + SESSION_GENERATION_STEP,
    }), expectedGeneration));
  }

  /**
   * True while the account exists at `generation`. Queued like a mutation, so a logout-all or delete admitted
   * earlier is seen; room operations call it at their admission point.
   * @returns {Promise<boolean>}
   */
  checkGeneration(id, generation) { return this.#enqueue(async () => Boolean(await this.#current(id, generation))); }

  setBoardSaved(id, generation, change) {
    return this.#enqueue(async () => {
      const account = await this.#current(id, generation);
      if (!account) return null;
      const current = account.savedBoardHandles ?? [];
      const next = updateSavedHandles(current, change);
      if (next.length !== current.length || next.some((handle, index) => handle !== current[index])) {
        await this.#write([put(accountKey(id), { ...account, savedBoardHandles: next })]);
      }
      return change.saved;
    });
  }

  /** @returns {Promise<boolean>} false when missing or, with `expectedGeneration`, stale */
  delete(id, { expectedGeneration } = {}) { return this.#enqueue(() => this.#delete(id, expectedGeneration)); }

  // Mutations queued before stop() still run; stop() resolves once they settle.
  async stop() {
    this.#stopped = true;
    await this.#chain;
  }

  #enqueue(operation) {
    if (this.#stopped) return Promise.reject(unavailableError());
    this.#pending += 1;
    const run = this.#chain
      .then(() => this.#runIfAvailable(operation))
      .finally(() => { this.#pending -= 1; });
    this.#chain = run.catch(ignoreRejection);
    return run;
  }

  #runIfAvailable(operation) {
    if (this.#failure) throw unavailableError();
    return operation();
  }

  #reportStorageFailure(error) {
    if (error?.code !== STORAGE_FAILURE_CODE || this.#failure) return;
    this.#failure = error;
    this.emit(ACCOUNT_STORAGE_FAILURE_EVENT, error);
  }

  async #read(key) {
    try {
      return (await this.#getMeta(ACCOUNTS_DOC_NAME, key)) ?? null;
    } catch (error) {
      this.#reportStorageFailure(error);
      throw error;
    }
  }

  async #write(ops) {
    try {
      await durableMetaBatch(this.#ldb, ACCOUNTS_DOC_NAME, ops);
    } catch (error) {
      this.#reportStorageFailure(error);
      throw error;
    }
  }

  // The sub index is removed only while it still points at this account.
  async #releaseIndex(key, id) {
    return (await this.#read(key)) === id ? [del(key)] : [];
  }

  async #emailIds(email) { return (await this.#read(emailKey(email))) ?? []; }

  async #addEmail(email, id) {
    const ids = await this.#emailIds(email);
    return ids.includes(id) ? [] : [put(emailKey(email), [...ids, id])];
  }

  async #removeEmail(email, id) {
    const ids = await this.#emailIds(email);
    if (!ids.includes(id)) return [];
    const remaining = ids.filter((other) => other !== id);
    return [remaining.length === 0 ? del(emailKey(email)) : put(emailKey(email), remaining)];
  }

  async #upsert(profile) {
    const id = await this.#read(subKey(profile.sub));
    const existing = id === null ? null : await this.get(id);
    return existing ? this.#refresh(existing, profile) : this.#create(profile);
  }

  async #create({ sub, email, name }) {
    if (!this.#hasCapacity()) throw codedError(DATABASE_CAPACITY_MESSAGE, DATABASE_CAPACITY_CODE);
    const account = {
      id: this.#randomId(), googleSub: sub, email, name, plan: PLAN.FREE,
      planGrantedAt: null, sessionGeneration: INITIAL_SESSION_GENERATION, createdAt: this.#now(),
    };
    await this.#write([put(accountKey(account.id), account), put(subKey(sub), account.id), ...(await this.#addEmail(email, account.id))]);
    return account;
  }

  async #refresh(account, { email, name }) {
    const addedEmail = await this.#addEmail(email, account.id);
    if (addedEmail.length === 0 && account.email === email && account.name === name) return account;
    const refreshed = { ...account, email, name };
    const movedEmail = emailKey(account.email) === emailKey(email) ? [] : await this.#removeEmail(account.email, account.id);
    await this.#write([put(accountKey(account.id), refreshed), ...movedEmail, ...addedEmail]);
    return refreshed;
  }

  #setPlan(id, plan) {
    if (!isKnownPlan(plan)) throw codedError(UNKNOWN_PLAN_MESSAGE, UNKNOWN_PLAN_CODE);
    return this.#update(id, () => ({ plan, planGrantedAt: this.#now() }));
  }

  // The generation check runs inside the queued operation, so a request that
  // authenticated before a concurrent logout-all cannot act on its old session.
  async #current(id, expectedGeneration) {
    const account = await this.get(id);
    const stale = account && expectedGeneration !== undefined && account.sessionGeneration !== expectedGeneration;
    return stale ? null : account;
  }

  async #update(id, changes, expectedGeneration) {
    const account = await this.#current(id, expectedGeneration);
    if (!account) return null;
    const updated = { ...account, ...changes(account) };
    await this.#write([put(accountKey(id), updated)]);
    return updated;
  }

  async #delete(id, expectedGeneration) {
    const account = await this.#current(id, expectedGeneration);
    if (!account) return false;
    const releasedSub = await this.#releaseIndex(subKey(account.googleSub), id);
    const releasedEmail = await this.#removeEmail(account.email, id);
    await this.#write([del(accountKey(id)), ...releasedSub, ...releasedEmail]);
    return true;
  }
}
