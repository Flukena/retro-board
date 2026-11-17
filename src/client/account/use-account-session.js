import { useEffect, useSyncExternalStore } from 'react';
import { accountSessionStore } from './account-session-store.js';

const serverSnapshot = () => null;

/** The shared account session, or null while it is still loading (so nothing flashes before it is known). */
export function useAccountSession() {
  const session = useSyncExternalStore(accountSessionStore.subscribe, accountSessionStore.getSnapshot, serverSnapshot);
  useEffect(() => { void accountSessionStore.load(); }, []);
  return session;
}
