import { useEffect, useRef, useState } from 'react';
import { ROOM_SESSION_ERROR, RoomSessionError } from '../session/room-session.js';

export const ROOM_BOOTSTRAP_STATUS = Object.freeze({ CHECKING: 'checking', READY: 'ready' });

export const roomBootstrapFailure = (error) => (error instanceof RoomSessionError
  ? { status: error.code, retryAfterSeconds: error.retryAfterSeconds }
  : { status: ROOM_SESSION_ERROR.UNAVAILABLE, retryAfterSeconds: null });

// Runs `start` (session exchange plus any room-specific loading) for one room
// and reports checking / ready / a ROOM_SESSION_ERROR code. `roomKey` restarts
// it for another room; `retry` runs it again after a failure.
export function useRoomBootstrap(start, roomKey) {
  const startRef = useRef(start);
  startRef.current = start;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: ROOM_BOOTSTRAP_STATUS.CHECKING, retryAfterSeconds: null });
  useEffect(() => {
    let cancelled = false;
    setState({ status: ROOM_BOOTSTRAP_STATUS.CHECKING, retryAfterSeconds: null });
    (async () => {
      try {
        await startRef.current();
        if (!cancelled) setState({ status: ROOM_BOOTSTRAP_STATUS.READY, retryAfterSeconds: null });
      } catch (error) {
        if (!cancelled) setState(roomBootstrapFailure(error));
      }
    })();
    return () => { cancelled = true; };
  }, [attempt, roomKey]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
