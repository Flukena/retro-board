import { useCallback, useEffect, useState } from 'react';
import { t } from '../ui/i18n.js';
import {
  ACCOUNT_STATUS, deleteAccount, fetchAccount, logout, logoutAll, readAuthError,
} from './account-api.js';

const TOAST_DURATION_MS = 5000;
const TOAST_TYPE = Object.freeze({ INFO: 'info', WARN: 'warn' });
const ACTIONS = Object.freeze({ logout, logoutAll, deleteAccount });

const currentLinkWithoutFragment = () => `${location.origin}${location.pathname}${location.search}`;

// State and actions behind the account menu; the component only renders.
export function useAccountMenu() {
  const [session, setSession] = useState({ status: null });
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setSession(await fetchAccount());
  }, []);

  useEffect(() => {
    const code = readAuthError();
    if (code) setToast({ msg: t(`account.error.${code}`), type: TOAST_TYPE.WARN });
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const run = useCallback(async (name) => {
    try {
      await ACTIONS[name]();
      setSession({ status: ACCOUNT_STATUS.SIGNED_OUT });
      return true;
    } catch {
      setToast({ msg: t('account.failed'), type: TOAST_TYPE.WARN });
      return false;
    }
  }, []);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentLinkWithoutFragment());
      setToast({ msg: t('account.copied'), type: TOAST_TYPE.INFO });
    } catch {
      setToast({ msg: t('account.failed'), type: TOAST_TYPE.WARN });
    }
  }, []);

  return { session, toast, closeToast: () => setToast(null), reload: load, run, copyLink };
}
