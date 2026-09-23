// y-websocket 1.x rebroadcasts remote awareness updates. This adapter is
// installed before connect() so the relay only receives our own identity.
export const sendOnlyLocalAwareness = (provider) => {
  const awareness = provider.awareness;
  const original = provider._awarenessUpdateHandler;
  awareness.off('update', original);
  provider._awarenessUpdateHandler = (changes, origin) => {
    const own = {};
    for (const kind of ['added', 'updated', 'removed']) {
      own[kind] = changes[kind].filter((id) => id === awareness.clientID);
    }
    if (own.added.length || own.updated.length || own.removed.length) original(own, origin);
  };
  awareness.on('update', provider._awarenessUpdateHandler);
  return provider;
};

export const MOTION_BROADCAST_MS = 100;

// Cursor and viewport are one awareness state. Coalesce both streams while
// preserving immediate identity/editing updates made during the interval.
export const createMotionPublisher = (awareness) => {
  let pending = {};
  let timer = null;
  const flush = () => {
    timer = null;
    const fields = pending;
    pending = {};
    const state = awareness.getLocalState();
    if (state && Object.keys(fields).length) awareness.setLocalState({ ...state, ...fields });
  };
  return {
    set(field, value) {
      if (field !== 'cursor' && field !== 'view') return;
      if (value === null) {
        delete pending[field];
        if (!Object.keys(pending).length && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (awareness.getLocalState()?.[field] != null) awareness.setLocalStateField(field, null);
        return;
      }
      pending[field] = value;
      if (timer === null) timer = setTimeout(flush, MOTION_BROADCAST_MS);
    },
    destroy() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = {};
    },
  };
};
