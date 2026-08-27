import {
  useState, useRef, useEffect, useCallback,
} from 'react';
import { t } from './i18n.js';
import { isBoardCreatedByMe } from './router.js';

export const HEARTBEAT_MS = 5000;
export const ONLINE_WINDOW = 12000;
export const ADMIN_DEAD_MS = 15000;

// Salted hash so the same PIN on different boards has different hashes,
// blunting rainbow-table reuse. Web Crypto returns lowercase hex.
async function hashAdminPin(boardCode, pin) {
  const data = new TextEncoder().encode(`${boardCode || ''}:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Admin role: election, PIN gate, manual claim, and transfer. `board`/`boardRef`,
// `onlineUsers`, `presence`, `patchMeta`, `setToast` and `storage` are passed
// in from RetroBoard rather than recreated here — several of the callbacks
// below deliberately read `boardRef.current` instead of depending on `board`
// so they aren't recreated on every board mutation (see requireAdminPin/
// adminClaim below).
export function useAdminRole({
  userId, userName, board, boardRef, onlineUsers, presence,
  boardCode, boardToken, patchMeta, setToast, storage,
}) {
  const isAdmin = userId && board.adminUserId === userId;

  // Admin PIN gate. `pinPromptCfg.onSuccess` is the callback to invoke after
  // a successful set-or-verify. `pinSessionOkRef` short-circuits subsequent
  // prompts for the same tab session so admins aren't pestered each click.
  const [pinPromptCfg, setPinPromptCfg] = useState(null);
  const pinSessionOkRef = useRef(false);
  // Drop the PIN cached for this session the moment we stop being admin. The
  // intent of the PIN is "prove you're currently authorized" — if admin is
  // transferred away and later transferred back, the second tenure should
  // re-prompt rather than reuse a stale OK flag from the first tenure.
  useEffect(() => {
    if (!isAdmin) pinSessionOkRef.current = false;
  }, [isAdmin]);

  /* ============================================================
     Heartbeat + admin election
     ============================================================ */
  useEffect(() => {
    // Don't wait for the user to dismiss the name modal before heartbeating.
    // A creator who opens their freshly-made board and walks away would
    // otherwise never claim admin and leave the room orphaned. Fall back to a
    // generic label until they pick a real name.
    if (!userId) return undefined;
    const effectiveName = userName || 'Guest';
    const beat = async () => {
      // Only refresh OUR own awareness slot. Peers' state arrives via the
      // awareness 'change' event (wired in storage-bridge) which dispatches
      // a synthetic presence update — letting heartbeat also call
      // setPresence() would overwrite React state with a possibly-stale
      // local snapshot and cause peers to flicker in/out.
      const entry = { userId, name: effectiveName, lastSeen: Date.now() };
      await storage.set('presence', { [userId]: entry }, true);

      // Admin election — gated on sync to avoid claiming during cold start.
      // We read adminUserId straight from yMeta (not boardRef) so a heartbeat
      // firing in the gap between applyRemoteBoard and React commit doesn't
      // see a stale `null` and re-claim the role from the true current admin.
      if (!window.storage?.synced?.()) return;
      const adminUserId = window.storage?.getAdminUserId?.();
      const pmap = (await storage.get('presence', true))?.value || {};
      const adminSeen = adminUserId ? pmap[adminUserId]?.lastSeen || 0 : 0;
      const adminGone = !adminUserId || Date.now() - adminSeen > ADMIN_DEAD_MS;
      if (adminGone) {
        // Only auto-claim admin in boards THIS browser created. Otherwise a
        // guest who happens to be alone in someone else's board (e.g. admin
        // closed their tab) would silently inherit the role — confusing when
        // the same identity is then "admin of two boards at once". Non-creators
        // must use the PIN-gated Transfer Admin flow to take over.
        if (!isBoardCreatedByMe(boardCode, boardToken)) return;
        // The creator is the only eligible claimant, so there is no election to
        // run. Picking a winner from every online user was self-defeating: a
        // guest whose random userId sorted first became the "winner", the
        // creator then failed `winner === userId`, and the guest had already
        // returned at the gate above — leaving the board with no admin at all.
        //
        // Re-read adminUserId from yMeta right before claiming. The await
        // calls above let other clients (or our own remote update) write
        // adminUserId in between; without this CAS-style guard we'd
        // overwrite a fresh claim with our own and produce two admins
        // diverging until the next sync round. Compare against the value we
        // sampled before those awaits, not against our own id: in the very
        // case this election exists for — a stale admin who left — the field
        // still holds that departed user's id, which never equals ours, so
        // comparing to `userId` aborted the claim every single time.
        const latestAdmin = window.storage?.getAdminUserId?.();
        if (latestAdmin !== adminUserId) return;
        // Immediate flush — bypass the 200ms debounce so the claim lands
        // in yMeta on the first tick. Otherwise a second client racing
        // the same election can miss our write and double-claim.
        patchMeta({ adminUserId: userId, adminName: effectiveName });
        setToast({ msg: t('transfer.becomeAdmin'), type: 'info' });
      }
    };
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    // Run election once more right after the initial WebSocket sync. Without
    // this we'd wait up to a full HEARTBEAT_MS for the first eligible
    // election attempt — long enough for users to think admin is broken.
    const offSynced = window.storage?.onSynced?.(beat) || (() => {});
    return () => { clearInterval(id); offSynced(); };
  }, [userId, userName, boardCode, boardToken, storage, patchMeta, setToast]);

  // Gate every destructive action behind a PIN. First call ever (no PIN on
  // the board yet) opens the modal in "set" mode and stores the hash; later
  // calls open it in "verify" mode. Once verified, we remember it for the
  // rest of this tab session via pinSessionOkRef so the admin isn't pestered.
  const requireAdminPin = useCallback((onSuccess) => {
    if (!isAdmin) {
      setToast({ msg: t('common.adminOnly'), type: 'warn' });
      return;
    }
    if (pinSessionOkRef.current) {
      // Revalidate here too: React state may lag behind the live admin role.
      if (window.storage?.getAdminUserId?.() !== userId) {
        pinSessionOkRef.current = false;
        setToast({ msg: t('common.adminOnly'), type: 'warn' });
        return;
      }
      onSuccess();
      return;
    }
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      setToast({ msg: t('pin.needsHttps') || 'Admin PIN requires HTTPS', type: 'warn' });
      return;
    }
    const hasPin = !!boardRef.current.adminPinHash;
    setPinPromptCfg({
      isSetting: !hasPin,
      error: null,
      onSuccess: async (pin) => {
        const hash = await hashAdminPin(boardCode, pin);
        // Revalidate before anything is written, not just at button press.
        // `isAdmin` was captured when this callback was built; the role can be
        // transferred away while the modal is open or during the hash above.
        // This has to precede the patchMeta below — otherwise someone who has
        // just lost the role still writes adminPinHash into the shared board.
        // adminClaim already does a live re-read before committing; this path
        // was the asymmetric one.
        if (window.storage?.getAdminUserId?.() !== userId) {
          setPinPromptCfg(null);
          setToast({ msg: t('common.adminOnly'), type: 'warn' });
          return;
        }
        const cur = boardRef.current.adminPinHash;
        if (!cur) {
          // Set mode — persist the new PIN's hash into the shared board.
          patchMeta({ adminPinHash: hash });
        } else if (cur !== hash) {
          // Verify mode — wrong PIN, keep modal open with error.
          setPinPromptCfg((cfg) => (cfg ? { ...cfg, error: 'wrong' } : cfg));
          return;
        }
        pinSessionOkRef.current = true;
        setPinPromptCfg(null);
        onSuccess();
      },
      onCancel: () => setPinPromptCfg(null),
    });
  }, [isAdmin, userId, boardCode, boardRef, patchMeta, setToast]);

  // Claim admin when there is none active. Anyone holding the PIN can take
  // over a vacant role. Without this flow a board where the creator lost
  // localStorage (or the only admin closed the tab and never came back) would
  // be permanently stuck — no Clear / Reset / Timer / Import / Transfer.
  //
  // `canClaim` mirrors the exact live-admin guard adminClaim() checks below,
  // so the claim button's render check and its click handler can never
  // disagree — both read the same window.storage.getAdminUserId() value.
  const liveAdmin = window.storage?.getAdminUserId?.() || null;
  const adminOnline = !!liveAdmin && onlineUsers.some((u) => u.userId === liveAdmin);
  const canClaim = !isAdmin && !!userId && !adminOnline;

  const adminClaim = useCallback(() => {
    if (isAdmin || !userId) return;
    const claimLiveAdmin = window.storage?.getAdminUserId?.() || null;
    // Bail if there's a currently-online admin — the existing Transfer flow
    // is the right route, not a silent take-over.
    if (claimLiveAdmin && onlineUsers.some((u) => u.userId === claimLiveAdmin)) {
      setToast({ msg: t('common.adminOnly'), type: 'warn' });
      return;
    }
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      setToast({ msg: t('pin.needsHttps') || 'Admin PIN requires HTTPS', type: 'warn' });
      return;
    }
    const hasPin = !!boardRef.current.adminPinHash;
    setPinPromptCfg({
      isSetting: !hasPin,
      error: null,
      claim: true,
      onSuccess: async (pin) => {
        const hash = await hashAdminPin(boardCode, pin);
        const curHash = boardRef.current.adminPinHash;
        if (curHash && curHash !== hash) {
          setPinPromptCfg((cfg) => (cfg ? { ...cfg, error: 'wrong' } : cfg));
          return;
        }
        // CAS-style re-check post-await — if a peer just claimed admin in
        // the meantime, abort rather than overwrite their fresh claim.
        const latestPresence = (await storage.get('presence', true))?.value || {};
        const latestAdmin = window.storage?.getAdminUserId?.();
        const latestAdminSeen = latestAdmin ? latestPresence[latestAdmin]?.lastSeen || 0 : 0;
        if (latestAdmin && Date.now() - latestAdminSeen < ONLINE_WINDOW) {
          setPinPromptCfg(null);
          setToast({ msg: t('common.adminOnly'), type: 'warn' });
          return;
        }
        patchMeta({
          adminUserId: userId,
          adminName: userName || 'Guest',
          // First-ever claim doubles as set-PIN.
          adminPinHash: curHash || hash,
        });
        pinSessionOkRef.current = true;
        setPinPromptCfg(null);
        setToast({ msg: t('transfer.becomeAdmin'), type: 'info' });
      },
      onCancel: () => setPinPromptCfg(null),
    });
  }, [isAdmin, userId, userName, boardCode, onlineUsers, boardRef, patchMeta, setToast, storage]);

  const adminTransfer = useCallback((toId) => {
    if (!isAdmin) return;
    const toName = presence[toId]?.name || '';
    // Immediate write — admin transfer is a hand-off; if our own heartbeat
    // fires first we'd still see ourselves as admin and could accidentally
    // rewrite the role back to us in the same tick.
    patchMeta({ adminUserId: toId, adminName: toName });
    setToast({ msg: t('transfer.done'), type: 'info' });
  }, [isAdmin, presence, patchMeta, setToast]);

  return {
    isAdmin, canClaim, pinPromptCfg, requireAdminPin, adminClaim, adminTransfer,
  };
}
