import { useEffect, useState } from 'react';
import { fetchAccount } from './account-api.js';

/** The account session, or null while it is still loading (so nothing flashes before it is known). */
export function useAccountSession() {
  const [session, setSession] = useState(null);
  useEffect(() => {
    let live = true;
    fetchAccount().then((next) => { if (live) setSession(next); });
    return () => { live = false; };
  }, []);
  return session;
}
