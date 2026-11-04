import { BOARD_MODE } from './public-wall-contract.js';

// Presenter mode: the admin sets `meta.presenterUserId` and every other viewer
// follows that person's viewport. A viewer who pans away has opted out until
// they rejoin or a different presenter starts. This is a workflow aid for
// cooperating participants, not access control (SECURITY.md).

export const PRESENTER_ACTION = Object.freeze({ FOLLOW: 'follow', STOP: 'stop', NONE: 'none' });
export const PRESENTER_BANNER = Object.freeze({ PRESENTING: 'presenting', INVITE: 'invite' });

/** Public rooms have no single facilitator, so presenter mode is private-only. */
export const presenterAvailable = (mode) => mode !== BOARD_MODE.PUBLIC;

/**
 * One reconciliation step between the room's presenter and this viewer's follow
 * state. `prev*` are the values seen on the previous step.
 */
export function presenterFollowStep({ presenter, prevPresenter, prevFollowed, followed, optedOutFor, userId, presenterOnline }) {
  let optOut = presenter === prevPresenter ? optedOutFor : null;
  const leftPresenter = prevFollowed === presenter && followed !== presenter;
  if (presenter && leftPresenter && presenterOnline) optOut = presenter;
  if (!presenter || presenter === userId) {
    const endedWhileFollowing = Boolean(prevPresenter) && followed === prevPresenter;
    return { action: endedWhileFollowing ? PRESENTER_ACTION.STOP : PRESENTER_ACTION.NONE, optedOutFor: null };
  }
  const shouldFollow = presenterOnline && followed !== presenter && optOut !== presenter;
  return { action: shouldFollow ? PRESENTER_ACTION.FOLLOW : PRESENTER_ACTION.NONE, optedOutFor: optOut };
}

/** Banner for this viewer: presenting themselves, or invited back after opting out. */
export function presenterBanner({ presenter, userId, followed, optedOutFor, presenterOnline }) {
  if (!presenter) return null;
  if (presenter === userId) return PRESENTER_BANNER.PRESENTING;
  if (followed !== presenter && optedOutFor === presenter && presenterOnline) return PRESENTER_BANNER.INVITE;
  return null;
}
