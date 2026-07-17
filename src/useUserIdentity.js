import {
  useState, useRef, useEffect, useCallback,
} from 'react';

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
    setNameDraft(name || `Guest-${Math.floor(1000 + Math.random() * 9000)}`);
    if (!name) setNameModalOpen(true);
  }, []);

  const saveName = useCallback(async () => {
    const n = nameDraft.trim() || `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
    setUserName(n);
    setNameModalOpen(false);
    await storage.set('userName', n, false);
  }, [nameDraft, storage]);

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
  };
}
