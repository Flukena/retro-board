import React from 'react';
import { Check } from 'lucide-react';
import { Avatar } from '../ui/Avatar.jsx';
import { t } from '../ui/i18n.js';

const ICON_SIZE_PX = 14;

function playerStatus(seat, hasStory) {
  if (!seat.online) return t('poker.table.offline');
  if (!hasStory) return '';
  return seat.voted ? t('poker.table.voted') : t('poker.table.waiting');
}

// Everyone in the room, with whether they have voted on the active story.
export function PlayerList({ seats, hasStory }) {
  const online = seats.filter((seat) => seat.online).length;
  return (
    <section className="rb-poker-players" aria-labelledby="poker-players-head">
      <h2 id="poker-players-head" className="rb-poker-stories__head">{t('poker.players.head', { count: online })}</h2>
      <ul className="rb-poker-players__list">
        {seats.map((seat) => (
          <li key={seat.userId} className={seat.online ? 'rb-poker-player' : 'rb-poker-player rb-poker-player--offline'}>
            <Avatar id={seat.userId} name={seat.name} small />
            <span className="rb-poker-player__name">{seat.isViewer ? `${seat.name} (${t('poker.table.you')})` : seat.name}</span>
            <span className={seat.voted && hasStory ? 'rb-poker-player__status rb-poker-player__status--voted' : 'rb-poker-player__status'}>
              {seat.voted && hasStory && seat.online && <Check size={ICON_SIZE_PX} aria-hidden="true" />}
              {playerStatus(seat, hasStory)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
