import React, { useState } from 'react';
import { t } from '../ui/i18n.js';

const JOIN_TIMEOUT_MS = 8000;

export function RoomAccess({handle}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const join = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(handle)}/join`, {
        method:'POST', credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(JOIN_TIMEOUT_MS),
      });
      if (!response.ok) { setError(response.status === 401 ? 'maintainer.sessionExpired' : 'maintainer.joinFailed'); return; }
      const {url} = await response.json();
      window.location.assign(url);
    } catch {
      setError('maintainer.joinFailed');
    } finally {
      setBusy(false);
    }
  };
  return <><button disabled={busy} onClick={()=>void join()}>{t(busy ? 'maintainer.loading' : 'maintainer.openRoom')}</button>
    <small>{t('maintainer.joinHint')}</small>{error && <p role="alert">{t(error)}</p>}</>;
}
