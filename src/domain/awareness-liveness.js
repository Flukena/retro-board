// y-protocols awareness.outdatedTimeout; kept pure to avoid eager Yjs loading.
export const PLAYER_PRESENCE_STALE_MS = 30_000;

export function isAwarenessSlotFresh(metadata, clientId, atTime) {
  const lastUpdated = metadata?.get(clientId)?.lastUpdated;
  return !Number.isFinite(lastUpdated) || atTime - lastUpdated < PLAYER_PRESENCE_STALE_MS;
}
