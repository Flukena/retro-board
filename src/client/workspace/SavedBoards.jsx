import React, { useState } from 'react';
import { Star } from 'lucide-react';
import { boardBookmark, listSavedBoards } from '../account/account-api.js';
import { useSavedBoardQuery } from '../account/use-saved-board-query.js';
import { tokenFromLink } from '../account/my-boards-controller.js';
import { getLang, t } from '../ui/i18n.js';
import { Button } from '../ui/UiPrimitives.jsx';
import WorkspaceCard from './WorkspaceCard.jsx';
import { roomNameOf, visibleRooms } from './workspace-model.js';

const STAR_SIZE_PX = 20;

export function SavedBoardCard({ room, now, busy, onRemove }) {
  return <WorkspaceCard room={room} now={now} savedAction={
    <button type="button" className="rb-workspace-card__more" disabled={busy}
      title={t('savedBoards.remove')} aria-label={t('savedBoards.removeNamed', { name: roomNameOf(room) })}
      onClick={() => onRemove(room)}><Star size={STAR_SIZE_PX} fill="currentColor" aria-hidden="true" /></button>
  } />;
}

export default function SavedBoards({ now, query, sort }) {
  const { value: rooms, setValue: setRooms, failed, setFailed, retry } = useSavedBoardQuery(listSavedBoards);
  const [busy, setBusy] = useState(null);

  async function remove(room) {
    setBusy(room.code);
    setFailed(false);
    try {
      await boardBookmark('remove', room.code, tokenFromLink(room.link));
      setRooms(list => list.filter(item => item.link !== room.link));
    } catch { setFailed(true); }
    finally { setBusy(null); }
  }

  const visible = visibleRooms(rooms ?? [], { query, sort, locale: getLang() });
  return (
    <section className="rb-workspace__saved" aria-labelledby="saved-boards-title">
      <h2 id="saved-boards-title">{t('savedBoards.title')}</h2>
      {failed && <p role="alert">{t('account.failed')} <Button onClick={retry}>{t('account.retry')}</Button></p>}
      {!rooms && !failed && <p role="status">{t('myBoards.loading')}</p>}
      {rooms && rooms.length === 0 && <p>{t('savedBoards.empty')}</p>}
      {visible.length > 0 && <ul className="rb-workspace__grid">
        {visible.map(room => <SavedBoardCard key={room.link} room={room} now={now} busy={busy !== null} onRemove={remove} />)}
      </ul>}
    </section>
  );
}
