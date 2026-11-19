import { ACCOUNT_STATUS } from '../account/account-api.js';

/** What `/` shows: the guest landing or the signed-in person's workspace. */
export const HOME_VIEW = Object.freeze({ LANDING: 'landing', WORKSPACE: 'workspace' });

/** Set on <html> by public/home-hint.js before first paint; home.css hides the guest landing while it is there. */
export const HOME_HINT_CLASS = 'rb-home-hinted';

const GUEST_STATUSES = Object.freeze([ACCOUNT_STATUS.SIGNED_OUT, ACCOUNT_STATUS.DISABLED]);

/**
 * A known answer from the relay decides the page. Until then, or while the relay is unavailable,
 * this browser's signed-in hint does, so a returning person never sees the landing first.
 */
export function homeViewFor({ hinted, session }) {
  const status = session?.status ?? null;
  if (status === ACCOUNT_STATUS.SIGNED_IN) return HOME_VIEW.WORKSPACE;
  if (GUEST_STATUSES.includes(status)) return HOME_VIEW.LANDING;
  return hinted ? HOME_VIEW.WORKSPACE : HOME_VIEW.LANDING;
}
