import { isBoardCreatedByMe } from './router.js';

// Decision functions read explicit snapshots; orchestration supplies fresh
// snapshots after each awaited operation. Continuations use the supplied patchMeta.
export const ADMIN_PIN_RESULT = Object.freeze({ DENIED: 'denied', WRONG: 'wrong', READY: 'ready' });

export const adminIsOnline = (adminUserId, users) => (
  !!adminUserId && users.some((user) => user.userId === adminUserId)
);

export const canUseCachedPin = (userId, liveAdmin) => liveAdmin === userId;

export const adminPinDecision = ({ userId, liveAdmin, currentHash, hash }) => {
  if (liveAdmin !== userId) return { status: ADMIN_PIN_RESULT.DENIED };
  if (currentHash && currentHash !== hash) return { status: ADMIN_PIN_RESULT.WRONG };
  return { status: ADMIN_PIN_RESULT.READY, patch: currentHash ? null : { adminPinHash: hash } };
};

const HASH_ALGORITHM = 'SHA-256';
const HASH_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const HEX_PADDING = '0';

export async function hashAdminPin(boardCode, pin) {
  const data = new TextEncoder().encode(`${boardCode || ''}:${pin}`);
  const buffer = await crypto.subtle.digest(HASH_ALGORITHM, data);
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(HASH_RADIX).padStart(HEX_BYTE_WIDTH, HEX_PADDING)).join('');
}

// Generators expose the existing await boundaries to the hook coordinator.
// next(await step.value) performs the final live check synchronously in the
// caller's continuation, immediately before patchMeta.
export function* adminPinSteps({ boardCode, pin, userId, liveStorage, boardRef, hashPin = hashAdminPin }) {
  const hash = yield hashPin(boardCode, pin);
  // The role captured when opening the prompt may be stale after hashing.
  // Revalidate the live role before permitting any adminPinHash write.
  return adminPinDecision({ userId, liveAdmin: liveStorage.getAdminUserId?.(),
    currentHash: boardRef.current.adminPinHash, hash });
}

export function* adminClaimSteps({ boardCode, pin, userId, liveStorage, storage,
  boardRef, hashPin = hashAdminPin }) {
  const hash = yield hashPin(boardCode, pin);
  const currentHash = boardRef.current.adminPinHash;
  if (currentHash && currentHash !== hash) return { status: ADMIN_PIN_RESULT.WRONG };
  const presence = (yield storage.get('presence', true))?.value || {};
  // Hashing and the presence read let peers claim admin. Re-read the live
  // role after both awaits so this claim cannot overwrite an online admin.
  const latestAdmin = liveStorage.getAdminUserId?.();
  if (latestAdmin && presence[latestAdmin]) return { status: ADMIN_PIN_RESULT.DENIED };
  return { status: ADMIN_PIN_RESULT.READY, patch: {
    adminUserId: userId, adminPinHash: currentHash || hash,
  } };
}

export function* adminElectionSteps({ userId, effectiveName, storage, liveStorage, boardCode, boardToken }) {
  const entry = { userId, name: effectiveName, lastSeen: Date.now() };
  yield storage.set('presence', { [userId]: entry }, true);
  if (!liveStorage.synced?.()) return false;
  const sampledAdmin = liveStorage.getAdminUserId?.();
  const presence = (yield storage.get('presence', true))?.value || {};
  // Auto-claim only in boards this browser created; a lone guest must use
  // the PIN-gated claim flow. Electing among all users was self-defeating: a guest
  // could win the sort but could not claim, leaving the creator unable to act.
  if (sampledAdmin && presence[sampledAdmin]) return false;
  if (!isBoardCreatedByMe(boardCode, boardToken)) return false;
  // Presence awaits can let a peer claim. Compare against the sampled admin,
  // not userId: a departed admin's id is legitimately still stored here.
  return liveStorage.getAdminUserId?.() === sampledAdmin;
}

export function finishAdminPin({ decision, patchMeta, markPinOk, onSuccess }) {
  if (decision.patch && !patchMeta(decision.patch)) return;
  markPinOk();
  onSuccess();
}

export function finishAdminClaim({ decision, adminName, patchMeta, markPinOk, onSuccess, notify }) {
  if (!patchMeta({
    adminUserId: decision.patch.adminUserId,
    adminName,
    adminPinHash: decision.patch.adminPinHash,
  })) return;
  markPinOk();
  onSuccess();
  notify();
}

export function finishAdminElection({ decision, userId, adminName, patchMeta, notify }) {
  if (!decision) return;
  // Flush before notifying so the next claimant sees this write immediately.
  if (!patchMeta({ adminUserId: userId, adminName })) return;
  notify();
}
