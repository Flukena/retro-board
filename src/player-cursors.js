export const DEFAULT_PLAYER_NAME = 'Guest';

export const PLAYER_CURSOR_STALE_MS = 10_000;
export const PLAYER_CURSOR_MAX_WORLD_COORD = 10_000_000;
export const PLAYER_VIEW_ZOOM_MIN = 0.15;
export const PLAYER_VIEW_ZOOM_MAX = 3;

export const normalizePlayerCursor = (cursor) => {
  if (!cursor || typeof cursor !== 'object') return null;
  const x = Number(cursor.x);
  const y = Number(cursor.y);
  const updatedAt = Number(cursor.updatedAt);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(updatedAt)) return null;
  if (Math.abs(x) > PLAYER_CURSOR_MAX_WORLD_COORD || Math.abs(y) > PLAYER_CURSOR_MAX_WORLD_COORD) return null;
  if (updatedAt <= 0) return null;
  return { x, y, updatedAt };
};

export const normalizePlayerView = (view) => {
  if (!view || typeof view !== 'object') return null;
  const zoom = Number(view.zoom);
  const updatedAt = Number(view.updatedAt);
  if (!Number.isFinite(zoom) || !Number.isFinite(updatedAt)) return null;
  if (zoom < PLAYER_VIEW_ZOOM_MIN || zoom > PLAYER_VIEW_ZOOM_MAX || updatedAt <= 0) return null;
  const normalized = { zoom, updatedAt };
  const x = Number(view.x);
  const y = Number(view.y);
  if (Number.isFinite(x) && Number.isFinite(y)
    && Math.abs(x) <= PLAYER_CURSOR_MAX_WORLD_COORD
    && Math.abs(y) <= PLAYER_CURSOR_MAX_WORLD_COORD) {
    normalized.x = x;
    normalized.y = y;
  }
  return normalized;
};

export const playerViewFromViewport = (viewport, viewportSize) => {
  const zoom = Number(viewport?.zoom);
  const offsetX = Number(viewport?.x);
  const offsetY = Number(viewport?.y);
  const width = Number(viewportSize?.w);
  const height = Number(viewportSize?.h);
  if (!Number.isFinite(zoom) || zoom < PLAYER_VIEW_ZOOM_MIN || zoom > PLAYER_VIEW_ZOOM_MAX) return null;
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const x = (width / 2 - offsetX) / zoom;
  const y = (height / 2 - offsetY) / zoom;
  if (Math.abs(x) > PLAYER_CURSOR_MAX_WORLD_COORD || Math.abs(y) > PLAYER_CURSOR_MAX_WORLD_COORD) return null;
  return { x, y, zoom };
};

export const mergePlayerPresence = (previous, user, cursorValue, viewValue) => {
  const next = !previous || Number(user?.lastSeen || 0) > Number(previous.lastSeen || 0)
    ? { ...user }
    : { ...previous };
  const candidateCursor = normalizePlayerCursor(cursorValue);
  const previousCursor = normalizePlayerCursor(previous?.cursor);
  const cursor = candidateCursor
    && (!previousCursor || candidateCursor.updatedAt > previousCursor.updatedAt)
    ? candidateCursor
    : previousCursor;
  if (cursor) next.cursor = cursor;
  else delete next.cursor;
  const candidateView = normalizePlayerView(viewValue);
  const previousView = normalizePlayerView(previous?.view);
  const view = candidateView
    && (!previousView || candidateView.updatedAt > previousView.updatedAt)
    ? candidateView
    : previousView;
  if (view) next.view = view;
  else delete next.view;
  return next;
};

// Only live awareness slots are included. Yjs owns expiry and disconnects;
// sender timestamps are used for merging tab metadata, never for liveness.
export const readPlayerPresence = (states) => {
  const out = Object.create(null);
  states.forEach((state) => {
    if (!state?.user?.userId) return;
    out[state.user.userId] = mergePlayerPresence(
      out[state.user.userId], state.user, state.cursor, state.view,
    );
  });
  return out;
};

export const visiblePlayerCursors = ({
  presence,
  currentUserId,
  now,
  staleMs = PLAYER_CURSOR_STALE_MS,
}) => Object.values(presence || {}).flatMap((player) => {
  if (!player || player.userId === currentUserId) return [];
  const cursor = normalizePlayerCursor(player.cursor);
  if (!cursor || now - cursor.updatedAt >= staleMs) return [];
  return [{
    userId: player.userId,
    name: String(player.name || DEFAULT_PLAYER_NAME),
    cursor,
  }];
});

export const cursorScreenPosition = (cursor, viewport) => ({
  x: Number(cursor.x) * Number(viewport.zoom) + Number(viewport.x),
  y: Number(cursor.y) * Number(viewport.zoom) + Number(viewport.y),
});
