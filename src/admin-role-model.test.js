import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PIN_RESULT, adminIsOnline, canUseCachedPin,
  adminPinDecision, hashAdminPin, adminPinSteps,
  adminClaimSteps, adminElectionSteps } from './admin-role-model.js';

const SELF = 'creator';
const PEER = 'peer';
const HASH = 'verified-hash';
const OTHER_HASH = 'other-hash';
const BOARD_CODE = 'TEST';
const PIN = '1234';
const boardRef = () => ({ current: { adminPinHash: null } });
const pending = () => Promise.withResolvers();

// Drive the same explicit awaits as the hook. Record writes/success only for
// ready decisions, and model patchMeta's boolean failure contract.
async function finish(steps, writes, successes, writeOk = true) {
  let step = steps.next();
  while (!step.done) step = steps.next(await step.value);
  const decision = step.value;
  if (decision.status !== ADMIN_PIN_RESULT.READY) return decision;
  if (decision.patch) {
    writes.push(decision.patch);
    if (!writeOk) return decision;
  }
  successes.push(SELF);
  return decision;
}

function installCreatedBoards(t) {
  const records = [{ code: BOARD_CODE, token: null }];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => JSON.stringify(records),
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  return records;
}

async function finishElection(steps, writes = [], successes = []) {
  let step = steps.next();
  while (!step.done) step = steps.next(await step.value);
  if (step.value) { writes.push(SELF); successes.push(SELF); }
  return step.value;
}

test('creator auto-election requires initial sync, absent admin and unchanged live role', async (t) => {
  const records = installCreatedBoards(t);
  const eligible = { synced: true, creator: true, sampledAdmin: PEER, latestAdmin: PEER, presence: {} };
  const election = (input) => {
    records.length = 0;
    if (input.creator) records.push({ code: BOARD_CODE, token: null });
    let readCount = 0;
    return finishElection(adminElectionSteps({ userId: SELF, effectiveName: 'Guest', boardCode: BOARD_CODE,
      liveStorage: { synced: () => input.synced, getAdminUserId: () => {
        readCount += 1;
        return readCount === 1 ? input.sampledAdmin : input.latestAdmin;
      } },
      storage: { set: async () => {}, get: async () => ({ value: input.presence }) },
    }));
  };
  assert.equal(await election(eligible), true);
  for (const patch of [{ synced: false }, { creator: false }, { latestAdmin: SELF }, { presence: { [PEER]: {} } }]) {
    assert.equal(await election({ ...eligible, ...patch }), false);
  }
  assert.equal(await election({ ...eligible, sampledAdmin: undefined, latestAdmin: undefined }), true);
});

test('cached PIN requires the current live role, and online-admin checks use identity', () => {
  assert.equal(canUseCachedPin(SELF, SELF), true);
  assert.equal(canUseCachedPin(SELF, PEER), false);
  assert.equal(adminIsOnline(PEER, [{ userId: SELF }]), false);
  assert.equal(adminIsOnline(PEER, [{ userId: PEER }]), true);
  assert.equal(adminIsOnline(null, []), false);
});

test('PIN decisions deny a lost role before setting or verifying a hash', () => {
  for (const currentHash of [null, HASH, OTHER_HASH]) {
    assert.deepEqual(adminPinDecision({ userId: SELF, liveAdmin: PEER, currentHash, hash: HASH }),
      { status: ADMIN_PIN_RESULT.DENIED });
  }
  assert.deepEqual(adminPinDecision({ userId: SELF, liveAdmin: SELF, currentHash: null, hash: HASH }),
    { status: ADMIN_PIN_RESULT.READY, patch: { adminPinHash: HASH } });
  assert.deepEqual(adminPinDecision({ userId: SELF, liveAdmin: SELF, currentHash: HASH, hash: HASH }),
    { status: ADMIN_PIN_RESULT.READY, patch: null });
  assert.deepEqual(adminPinDecision({ userId: SELF, liveAdmin: SELF, currentHash: OTHER_HASH, hash: HASH }),
    { status: ADMIN_PIN_RESULT.WRONG });
});

test('manual claim requires the correct PIN and a vacant live role', async () => {
  const claim = (presence) => finish(adminClaimSteps({ boardCode: BOARD_CODE, pin: PIN, userId: SELF,
    boardRef: boardRef(), hashPin: async () => HASH,
    storage: { get: async () => ({ value: presence }) },
    liveStorage: { getAdminUserId: () => PEER },
  }), [], []);
  assert.deepEqual(await claim({}), { status: ADMIN_PIN_RESULT.READY,
    patch: { adminUserId: SELF, adminPinHash: HASH } });
  assert.deepEqual(await claim({ [PEER]: {} }), { status: ADMIN_PIN_RESULT.DENIED });
  const ref = boardRef();
  ref.current.adminPinHash = OTHER_HASH;
  const writes = [], successes = [];
  const wrongPin = await finish(adminClaimSteps({ boardCode: BOARD_CODE, pin: PIN, userId: SELF,
    boardRef: ref, hashPin: async () => HASH,
    storage: { get: () => assert.fail('wrong PIN must return before reading presence') },
    liveStorage: { getAdminUserId: () => assert.fail('wrong PIN must return before reading admin') },
  }), writes, successes);
  assert.deepEqual(wrongPin, { status: ADMIN_PIN_RESULT.WRONG });
  assert.deepEqual(writes, []);
  assert.deepEqual(successes, []);
});

test('role lost during async PIN hashing causes no write and no success', async () => {
  const digest = pending();
  let liveAdmin = SELF;
  const writes = [], successes = [];
  const completion = finish(adminPinSteps({ boardCode: BOARD_CODE, pin: PIN, userId: SELF,
    liveStorage: { getAdminUserId: () => liveAdmin }, boardRef: boardRef(), hashPin: () => digest.promise }), writes, successes);
  liveAdmin = PEER;
  digest.resolve(HASH);
  assert.equal((await completion).status, ADMIN_PIN_RESULT.DENIED);
  assert.deepEqual(writes, []);
  assert.deepEqual(successes, []);
});

test('manual claim re-reads admin and presence after hashing and the presence await', async () => {
  const digest = pending();
  const presenceRead = pending();
  const readingPresence = pending();
  let liveAdmin = null;
  const writes = [], successes = [];
  const completion = finish(adminClaimSteps({ boardCode: BOARD_CODE, pin: PIN, userId: SELF,
    userName: 'Creator', liveStorage: { getAdminUserId: () => liveAdmin }, boardRef: boardRef(),
    hashPin: () => digest.promise, storage: { get: () => { readingPresence.resolve(); return presenceRead.promise; } } }), writes, successes);
  digest.resolve(HASH);
  await readingPresence.promise;
  liveAdmin = PEER;
  presenceRead.resolve({ value: { [PEER]: { userId: PEER } } });
  assert.equal((await completion).status, ADMIN_PIN_RESULT.DENIED);
  assert.deepEqual(writes, []);
  assert.deepEqual(successes, []);
});

test('hash changed during hashing is read freshly, and failed writes never succeed', async () => {
  const digest = pending();
  const ref = boardRef();
  const writes = [], successes = [];
  const completion = finish(adminPinSteps({ boardCode: BOARD_CODE, pin: PIN, userId: SELF,
    liveStorage: { getAdminUserId: () => SELF }, boardRef: ref, hashPin: () => digest.promise }), writes, successes);
  ref.current.adminPinHash = OTHER_HASH;
  digest.resolve(HASH);
  assert.equal((await completion).status, ADMIN_PIN_RESULT.WRONG);
  assert.deepEqual(writes, []);
  await finish(adminPinSteps({ boardCode: BOARD_CODE, pin: PIN, userId: SELF,
    liveStorage: { getAdminUserId: () => SELF }, boardRef: boardRef(), hashPin: async () => HASH }), writes, successes, false);
  assert.deepEqual(writes, [{ adminPinHash: HASH }]);
  assert.deepEqual(successes, []);
});

test('election stops before reading presence until the initial sync', async () => {
  const writes = [];
  const steps = adminElectionSteps({ userId: SELF, effectiveName: 'Guest',
    liveStorage: { synced: () => false },
    storage: { set: async (...args) => writes.push(args), get: () => assert.fail('unsynced presence read') } });
  assert.equal(steps.next(await steps.next().value).value, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'presence');
  assert.equal(writes[0][2], true);
});

test('admin hash is board-salted lowercase SHA-256', async () => {
  // Independent fixture: printf ":abc" | shasum -a 256.
  const expected = '6e850a0e91c14c7de98b0266362362c7c465aeff1df5c073d8976f81a333a874';
  const actual = await hashAdminPin('', 'abc');
  assert.match(actual, /^[0-9a-f]{64}$/);
  assert.notEqual(await hashAdminPin(BOARD_CODE, PIN), await hashAdminPin(PEER, PIN));
  assert.equal(actual, expected);
});

test('creator election re-reads the live admin after the awaited presence read', async (t) => {
  installCreatedBoards(t);
  const presenceRead = pending();
  const readingPresence = pending();
  let liveAdmin = PEER;
  const steps = adminElectionSteps({ userId: SELF, effectiveName: 'Guest', boardCode: BOARD_CODE,
    liveStorage: { synced: () => true, getAdminUserId: () => liveAdmin }, storage: {
      set: async () => {}, get: () => { readingPresence.resolve(); return presenceRead.promise; },
    } });
  const writes = [], successes = [];
  const completion = finishElection(steps, writes, successes);
  await readingPresence.promise;
  liveAdmin = 'new-admin';
  presenceRead.resolve({ value: {} });
  assert.equal(await completion, false);
  assert.deepEqual(writes, []);
  assert.deepEqual(successes, []);
});
