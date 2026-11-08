import {
  useState, useRef, useEffect, useCallback,
} from 'react';
import { randomGuestName } from './guest-name.js';
import { normalizeDisplayName } from './local-preferences.js';
import { prefillNameDraft } from './name-prefill.js';
import { fetchAccount } from '../account/account-api.js';

// Local participant identity: userId/userName plus the "set your name" modal.
// `storage` is the board's window.storage-backed wrapper (see RetroBoard.jsx),
// passed in rather than imported so this hook isn't tied to one board module.
export function useUserIdentity(storage, { loadAccount = fetchAccount } = {}) {
  const [userId, setUserId] = useState(null);
  const userIdRef = useRef(null);
  useEffect(() => { userIdRef.current = userId; }, [userId]);
  const [userName, setUserName] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [nameModalOpen, setNameModalOpen] = useState(false);
  // The generated guest name while the first-visit dialog still offers it.
  const placeholderRef = useRef(null);

  // Called once from RetroBoard's init effect after it loads (or generates)
  // userId/userName from storage. Without a stored name, a signed-in user's
  // Google name is offered in the dialog instead of the guest name.
  const hydrate = useCallback((id, name) => {
    setUserId(id);
    setUserName(name);
    if (name) { setNameDraft(name); return; }
    const placeholder = randomGuestName(Math.random);
    placeholderRef.current = placeholder;
    setNameDraft(placeholder);
    setNameModalOpen(true);
    void loadAccount().then((result) => {
      setNameDraft((draft) => prefillNameDraft(draft, placeholderRef.current, result));
    });
  }, [loadAccount]);

  const persistName = useCallback(async (name) => {
    placeholderRef.current = null;
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
    placeholderRef.current = null;
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
