import { rewrapRoomLock } from './e2e-crypto.js';
import { updateLockAfterPasswordChange } from './lock-session.js';

/**
 * Owner password change (spec §5.4): the same room key under a new password. Only the new lock record and the
 * old authKey (as proof) are sent; renewals on this page then use the new authKey. Sessions are not revoked.
 * `key` is getRoomKey(), `api` is createRoomLockApi(). Rejects with a RoomKeyError for a wrong current password
 * (nothing is sent), or a RoomLockActionError.
 */
export async function changeRoomPassword({ currentPassword, newPassword, key, api }) {
  const { lock, authKey, oldAuthKey } = await rewrapRoomLock({ currentPassword, lock: key.lock, newPassword });
  const { lockRevision } = await api.changePassword({ oldAuthKey, expectedRevision: key.lockRevision, lock });
  updateLockAfterPasswordChange({ lock, authKey, lockRevision });
}
