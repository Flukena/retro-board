import React, { useEffect, useState } from 'react';
import { Surface } from '../ui/UiPrimitives.jsx';
import { t, useLang } from '../ui/i18n.js';
import { TOAST_BOTTOM_PX, Z } from '../chrome/chrome-layout.js';
import { PUBLIC_CREATION_LIMIT_EVENT } from './public-creation-guard.js';
import { SYNC_STATE } from './sync-status.js';
import './client-resilience.css';

const MILLISECONDS_PER_SECOND = 1_000;
const OVERSIZED_NOTICE_MS = 5_000;

export function PublicCreationMessage({ oversized, seconds }) {
  useLang();
  return <span>{oversized ? t('public.creationLimit.batch') : t('public.creationLimit.wait', { seconds })}</span>;
}

export function PublicCreationNotice({ syncStatus }) {
  const [notice, setNotice] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const onLimit = event => {
      const current = Date.now();
      const duration = event.detail.oversized ? OVERSIZED_NOTICE_MS : event.detail.retryAfterSeconds * MILLISECONDS_PER_SECOND;
      setNow(current);
      setNotice({ ...event.detail, until: current + duration });
    };
    window.addEventListener(PUBLIC_CREATION_LIMIT_EVENT, onLimit);
    return () => window.removeEventListener(PUBLIC_CREATION_LIMIT_EVENT, onLimit);
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= notice.until) setNotice(null);
    }, MILLISECONDS_PER_SECOND);
    return () => clearInterval(timer);
  }, [notice]);
  if (!notice || syncStatus === SYNC_STATE.ACTION_LIMIT) return null;
  const seconds = Math.max(1, Math.ceil((notice.until - now) / MILLISECONDS_PER_SECOND));
  return <Surface role="status" aria-live="polite" className="rb-sync-banner"
    style={{ '--rb-sync-bottom-px': `${TOAST_BOTTOM_PX}px`, zIndex: Z.TOAST }}>
    <PublicCreationMessage oversized={notice.oversized} seconds={seconds} />
  </Surface>;
}
