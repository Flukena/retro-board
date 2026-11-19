import { PUBLIC_CREATION_LIMIT_EVENT } from '../public-creation-guard.js';
import { SYNC_STATE } from '../sync-status.js';

export function createPublicPermit({ publicCreationGuard, syncStatus, eventTarget }) {
let publicCreationFailure = false;
const rejectPublicCreation = () => {
  publicCreationFailure = true;
  queueMicrotask(() => { publicCreationFailure = false; });
  return false;
};
const permitPublicCreations = (items) => {
  if (!publicCreationGuard || items.length === 0) return true;
  if (syncStatus?.getSnapshot().status === SYNC_STATE.ACTION_LIMIT) return rejectPublicCreation();
  const result = publicCreationGuard.check(items);
  if (!result.allowed) {
    eventTarget.dispatchEvent(new CustomEvent(PUBLIC_CREATION_LIMIT_EVENT, { detail: result }));
    return rejectPublicCreation();
  }
  return true;
};
const consumePublicCreationFailure = () => {
  const failed = publicCreationFailure;
  publicCreationFailure = false;
  return failed;
};
return { permitPublicCreations, consumePublicCreationFailure };
}
