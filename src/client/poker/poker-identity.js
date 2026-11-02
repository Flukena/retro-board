// Planning Poker participant identity on this device. Kept apart from board
// identity (stored in the board document) because a team reuses the same
// name sprint after sprint across poker rooms.
import {
  normalizeDisplayName, normalizeStoredUserId, readLocalPreference, writeLocalPreference,
} from '../session/local-preferences.js';

const POKER_USER_ID_KEY = 'rb_poker_userId';
const POKER_USER_NAME_KEY = 'rb_poker_userName';

export function loadPokerIdentity(createId, storage) {
  let userId = normalizeStoredUserId(readLocalPreference(POKER_USER_ID_KEY, storage));
  if (!userId) {
    userId = createId();
    writeLocalPreference(POKER_USER_ID_KEY, userId, storage);
  }
  return { userId, userName: normalizeDisplayName(readLocalPreference(POKER_USER_NAME_KEY, storage)) };
}

export function savePokerName(name, storage) {
  const userName = normalizeDisplayName(name);
  writeLocalPreference(POKER_USER_NAME_KEY, userName, storage);
  return userName;
}
