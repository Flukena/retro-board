import {
  useState, useRef, useEffect, useCallback,
} from 'react';
import { t } from '../ui/i18n.js';
import { ADMIN_PIN_RESULT, adminIsOnline, canUseCachedPin, adminPinSteps, adminClaimSteps, adminElectionSteps,
  finishAdminPin, finishAdminClaim, finishAdminElection } from './admin-role-model.js';

export const HEARTBEAT_MS = 5000;

// Admin role: election, PIN gate, manual claim, and transfer. `board`/`boardRef`,
// `onlineUsers`, `presence`, `patchMeta`, `setToast` and `storage` are passed
// in from RetroBoard rather than recreated here — several of the callbacks
// below deliberately read `boardRef.current` instead of depending on `board`
// so they aren't recreated on every board mutation (see requireAdminPin/
// adminClaim below).
export function useAdminRole({
  userId, userName, board, boardRef, onlineUsers, presence,
  boardCode, boardToken, patchMeta, setToast, storage, liveStorage,
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
      const steps = adminElectionSteps({ userId, effectiveName, storage, liveStorage, boardCode, boardToken });
      let step = steps.next();
      while (!step.done) step = steps.next(await step.value);
      finishAdminElection({ decision: step.value, userId, adminName: effectiveName, patchMeta,
        notify: () => setToast({ msg: t('transfer.becomeAdmin'), type: 'info' }),
      });
    };
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    // Run election once more right after the initial WebSocket sync. Without
    // this we'd wait up to a full HEARTBEAT_MS for the first eligible
    // election attempt — long enough for users to think admin is broken.
    const offSynced = liveStorage.onSynced?.(beat) || (() => {});
    return () => { clearInterval(id); offSynced(); };
  }, [userId, userName, boardCode, boardToken, storage, liveStorage, patchMeta, setToast]);

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
      if (!canUseCachedPin(userId, liveStorage.getAdminUserId?.())) {
        pinSessionOkRef.current = false;
        setToast({ msg: t('common.adminOnly'), type: 'warn' });
        return;
      }
      onSuccess();
      return;
    }
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      setToast({ msg: t('pin.needsHttps'), type: 'warn' });
      return;
    }
    const hasPin = !!boardRef.current.adminPinHash;
    setPinPromptCfg({
      isSetting: !hasPin,
      error: null,
      onSuccess: async (pin) => {
        const steps = adminPinSteps({ boardCode, pin, userId, liveStorage, boardRef });
        const decision = steps.next(await steps.next().value).value;
        if (decision.status === ADMIN_PIN_RESULT.DENIED) {
          setPinPromptCfg(null);
          setToast({ msg: t('common.adminOnly'), type: 'warn' });
          return;
        }
        if (decision.status === ADMIN_PIN_RESULT.WRONG) {
          setPinPromptCfg((cfg) => (cfg ? { ...cfg, error: 'wrong' } : cfg));
          return;
        }
        finishAdminPin({ decision, patchMeta,
          markPinOk: () => { pinSessionOkRef.current = true; },
          onSuccess: () => { setPinPromptCfg(null); onSuccess(); },
        });
      },
      onCancel: () => setPinPromptCfg(null),
    });
  }, [isAdmin, userId, boardCode, boardRef, patchMeta, setToast, liveStorage]);

  // Claim admin when there is none active. Anyone holding the PIN can take
  // over a vacant role. Without this flow a board where the creator lost
  // localStorage (or the only admin closed the tab and never came back) would
  // be permanently stuck — no Clear / Reset / Timer / Import / Transfer.
  //
  // `canClaim` mirrors the exact live-admin guard adminClaim() checks below,
  // so the claim button's render check and its click handler can never
  // disagree — both read the same window.storage.getAdminUserId() value.
  const liveAdmin = liveStorage.getAdminUserId?.() || null;
  const adminOnline = adminIsOnline(liveAdmin, onlineUsers);
  const canClaim = !isAdmin && !!userId && !adminOnline;

  const adminClaim = useCallback(() => {
    if (isAdmin || !userId) return;
    const claimLiveAdmin = liveStorage.getAdminUserId?.() || null;
    // Bail if there's a currently-online admin — the existing Transfer flow
    // is the right route, not a silent take-over.
    if (adminIsOnline(claimLiveAdmin, onlineUsers)) {
      setToast({ msg: t('common.adminOnly'), type: 'warn' });
      return;
    }
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      setToast({ msg: t('pin.needsHttps'), type: 'warn' });
      return;
    }
    const hasPin = !!boardRef.current.adminPinHash;
    setPinPromptCfg({
      isSetting: !hasPin,
      error: null,
      claim: true,
      onSuccess: async (pin) => {
        const steps = adminClaimSteps({ boardCode, pin, userId, liveStorage, storage, boardRef });
        let step = steps.next();
        while (!step.done) step = steps.next(await step.value);
        const decision = step.value;
        if (decision.status === ADMIN_PIN_RESULT.WRONG) {
          setPinPromptCfg((cfg) => (cfg ? { ...cfg, error: 'wrong' } : cfg));
          return;
        }
        if (decision.status === ADMIN_PIN_RESULT.DENIED) {
          setPinPromptCfg(null);
          setToast({ msg: t('common.adminOnly'), type: 'warn' });
          return;
        }
        finishAdminClaim({ decision, adminName: userName || 'Guest', patchMeta,
          markPinOk: () => { pinSessionOkRef.current = true; },
          onSuccess: () => setPinPromptCfg(null),
          notify: () => setToast({ msg: t('transfer.becomeAdmin'), type: 'info' }),
        });
      },
      onCancel: () => setPinPromptCfg(null),
    });
  }, [isAdmin, userId, userName, boardCode, onlineUsers, boardRef, patchMeta, setToast, storage, liveStorage]);

  const adminTransfer = useCallback((toId) => {
    if (!isAdmin) return;
    const toName = presence[toId]?.name || '';
    // Immediate write — admin transfer is a hand-off; if our own heartbeat
    // fires first we'd still see ourselves as admin and could accidentally
    // rewrite the role back to us in the same tick.
    if (!patchMeta({ adminUserId: toId, adminName: toName })) return;
    setToast({ msg: t('transfer.done'), type: 'info' });
  }, [isAdmin, presence, patchMeta, setToast]);

  return {
    isAdmin, canClaim, pinPromptCfg, requireAdminPin, adminClaim, adminTransfer,
  };
}
