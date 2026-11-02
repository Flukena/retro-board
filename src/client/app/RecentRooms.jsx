import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ROOM_KIND, forgetRecent, gotoBoard, recentsOfKind } from './router.js';
import { t } from '../ui/i18n.js';
import { IconButton, Surface } from '../ui/UiPrimitives.jsx';
import { SURFACE_KIND } from '../ui/ui-variants.js';
import { formatRelativeTime } from '../ui/relative-time.js';
import './landing.css';

const REMOVE_ICON_SIZE_PX = 15;
const HEADING_ID_SUFFIX = '-title';

// Recent rooms of one kind. Read after mount: the list lives in this browser's
// storage, so prerendered pages never contain it.
export function useRecentRooms(kind) {
  const [recents, setRecents] = useState([]);
  useEffect(() => { setRecents(recentsOfKind(kind)); }, [kind]);
  const remove = (code, token) => {
    forgetRecent(code, token);
    setRecents(recentsOfKind(kind));
  };
  return { recents, remove };
}

// Poker rooms are created without a name, so they are titled by what they are.
const recentTitle = (recent) => recent.name || (recent.kind === ROOM_KIND.POKER ? t('poker.title') : recent.code);

export function RecentRow({ recent, onRemove }) {
  const removeLabel = t('landing.recents.remove');
  return (
    <div className="rb-landing__recent">
      <button
        type="button"
        className="rb-landing__recent-open"
        onClick={() => gotoBoard(recent.code, recent.token, recent.kind)}
      >
        <span className="rb-landing__recent-name">{recentTitle(recent)}</span>
        <span className="rb-landing__recent-detail">
          <span className="rb-landing__recent-code">{recent.code}</span>
          {t('landing.recents.separator')}
          <span>{formatRelativeTime(recent.visitedAt)}</span>
        </span>
      </button>
      <IconButton
        className="rb-landing__remove"
        onClick={() => onRemove(recent.code, recent.token)}
        title={removeLabel}
        aria-label={removeLabel}
      >
        <X size={REMOVE_ICON_SIZE_PX} />
      </IconButton>
    </div>
  );
}

export default function RecentRooms({ id, recents, onRemove }) {
  const headingId = `${id}${HEADING_ID_SUFFIX}`;
  return (
    <Surface id={id} role="region" aria-labelledby={headingId} tabIndex={-1}
      kind={SURFACE_KIND.CARD} className="rb-landing__card rb-landing__card--recents">
      <h2 id={headingId} className="rb-landing__section-head">{t('landing.recents.head')}</h2>
      {recents.map((recent) => (
        <RecentRow key={`${recent.code}#${recent.token || ''}`} recent={recent} onRemove={onRemove} />
      ))}
    </Surface>
  );
}
