import {
  useState, useRef, useEffect, useCallback,
} from 'react';
import { randomGuestName } from './guest-name.js';
import { normalizeDisplayName } from './local-preferences.js';

// Local participant identity: userId/userName plus the "set your name" modal.
// `storage` is the board's window.storage-backed wrapper (see RetroBoard.jsx),
// passed in rather than imported so this hook isn't tied to one board module.
export function useUserIdentity(storage) {
  const [userId, setUserId] = useState(null);
  const userIdRef = useRef(null);
  useEffect(() => { userIdRef.current = userId; }, [userId]);
  const [userName, setUserName] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [nameModalOpen, setNameModalOpen] = useState(false);

  // Called once from RetroBoard's init effect after it loads (or generates)
  // userId/userName from storage.
  const hydrate = useCallback((id, name) => {
    setUserId(id);
    setUserName(name);
    setNameDraft(name || randomGuestName(Math.random));
    if (!name) setNameModalOpen(true);
  }, []);

  const persistName = useCallback(async (name) => {
    setUserName(name);
    setNameDraft(name);
    setNameModalOpen(false);
    await storage.set('userName', name, false);
  }, [storage]);

  const saveName = useCallback(() => persistName(
    normalizeDisplayName(nameDraft) || randomGuestName(Math.random),
  ), [nameDraft, persistName]);

  const dismissName = useCallback(() => {
    if (!userName) return persistName(randomGuestName(Math.random));
    setNameDraft(userName);
    setNameModalOpen(false);
  }, [userName, persistName]);

  return {
    userId,
    userIdRef,
    userName,
    nameDraft,
    setNameDraft,
    nameModalOpen,
    setNameModalOpen,
    hydrate,
    saveName,
    dismissName,
  };
}
