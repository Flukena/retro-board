import React, { useCallback, useState } from 'react';
import { Star } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { Button } from '../ui/UiPrimitives.jsx';
import { TOPBAR_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import { boardBookmark, isSignedIn } from './account-api.js';
import { useAccountSession } from './use-account-session.js';
import { useSavedBoardQuery } from './use-saved-board-query.js';

export function BoardStar({ saved, failed, busy, onClick }) {
  const label = failed ? t('account.retry') : t(saved ? 'savedBoards.remove' : 'savedBoards.save');
  return (
    <Button className="rb-board-bookmark" title={label} aria-label={label} aria-pressed={saved === true}
      disabled={busy || (saved === null && !failed)} onClick={onClick}>
      <Star size={TOPBAR_ICON_SIZE_PX.ACTION} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
    </Button>
  );
}

function AccountStar({ code, token, onNotice }) {
  const read = useCallback(() => boardBookmark('status', code, token), [code, token]);
  const { value: saved, setValue: setSaved, failed, retry } = useSavedBoardQuery(read);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (failed) {
      retry();
      return;
    }
    setBusy(true);
    try {
      setSaved(await boardBookmark(saved ? 'remove' : 'save', code, token));
    } catch (error) {
      const key = error.code === 'saved-board-limit' ? 'savedBoards.limit' : 'account.failed';
      onNotice?.({ msg: t(key), type: 'warn' });
    } finally { setBusy(false); }
  }

  return <BoardStar saved={saved} failed={failed} busy={busy} onClick={toggle} />;
}

export function SaveBoardButton(props) {
  const session = useAccountSession();
  return isSignedIn(session) ? <AccountStar key={`${session.account.email}:${props.code}:${props.token}`} {...props} /> : null;
}
