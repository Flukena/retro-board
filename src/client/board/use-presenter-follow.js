import { useCallback, useEffect, useRef, useState } from 'react';
import { PRESENTER_ACTION, presenterAvailable, presenterBanner, presenterFollowStep } from '../../domain/presenter.js';

/**
 * Connects the room's presenter to the board's existing Follow. Writes are
 * silent (not undoable): Ctrl+Z must not end someone's presentation.
 */
export function usePresenterFollow({ mode, presenterUserId, userId, presence, followedUserId, startFollowing, stopFollowing, patchMeta }) {
  const [optedOutFor, setOptedOutFor] = useState(null);
  const previous = useRef({ presenter: null, followed: null });
  const presenter = presenterAvailable(mode) ? presenterUserId ?? null : null;
  const presenterOnline = Boolean(presenter && Object.hasOwn(presence, presenter));

  useEffect(() => {
    const { presenter: prevPresenter, followed: prevFollowed } = previous.current;
    previous.current = { presenter, followed: followedUserId };
    const next = presenterFollowStep({ presenter, prevPresenter, prevFollowed, followed: followedUserId, optedOutFor, userId, presenterOnline });
    if (next.optedOutFor !== optedOutFor) setOptedOutFor(next.optedOutFor);
    if (next.action === PRESENTER_ACTION.FOLLOW) startFollowing(presenter);
    if (next.action === PRESENTER_ACTION.STOP) stopFollowing();
  }, [presenter, followedUserId, optedOutFor, userId, presenterOnline, startFollowing, stopFollowing]);

  const startPresenting = useCallback(() => {
    stopFollowing();
    patchMeta({ presenterUserId: userId }, { silent: true });
  }, [patchMeta, stopFollowing, userId]);
  const stopPresenting = useCallback(() => patchMeta({ presenterUserId: null }, { silent: true }), [patchMeta]);
  const rejoin = useCallback(() => setOptedOutFor(null), []);

  return {
    available: presenterAvailable(mode),
    presenting: presenter !== null && presenter === userId,
    followingPresenter: presenter !== null && followedUserId === presenter,
    banner: presenterBanner({ presenter, userId, followed: followedUserId, optedOutFor, presenterOnline }),
    presenterId: presenter,
    startPresenting, stopPresenting, rejoin,
  };
}
