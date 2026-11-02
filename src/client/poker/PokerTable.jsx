import React from 'react';
import { Avatar } from '../ui/Avatar.jsx';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { cardLabel } from './poker-format.js';

function seatCardClass(seat, revealed) {
  if (!seat.voted) return 'rb-poker-seat__card rb-poker-seat__card--empty';
  if (revealed || seat.isViewer) return 'rb-poker-seat__card rb-poker-seat__card--up';
  return 'rb-poker-seat__card rb-poker-seat__card--down';
}

function Seat({ seat, deck, revealed }) {
  const status = seat.voted ? t('poker.table.voted') : t('poker.table.waiting');
  return (
    <li className={seat.online ? 'rb-poker-seat' : 'rb-poker-seat rb-poker-seat--offline'}>
      <div className={seatCardClass(seat, revealed)} aria-hidden="true">
        {seat.cardId === null ? '' : cardLabel(deck, seat.cardId)}
      </div>
      <Avatar id={seat.userId} name={seat.name} small />
      <span className="rb-poker-seat__name">
        {seat.isViewer ? `${seat.name} (${t('poker.table.you')})` : seat.name}
      </span>
      <span className="rb-poker-seat__status">
        {seat.online ? status : `${status} · ${t('poker.table.offline')}`}
      </span>
    </li>
  );
}

export function PokerTable({ seats, deck, story, onReveal, onReset, onNext, canNext }) {
  if (!story) return <section className="rb-poker-table rb-poker-table--idle"><p>{t('poker.table.pick')}</p></section>;
  const revealed = story.revealedAt !== null;
  const voted = seats.filter((seat) => seat.voted).length;
  return (
    <section className="rb-poker-table" aria-labelledby="poker-active-story">
      <h2 id="poker-active-story" className="rb-poker-table__story">{story.title}</h2>
      <ul className="rb-poker-seats">
        {seats.map((seat) => <Seat key={seat.userId} seat={seat} deck={deck} revealed={revealed} />)}
      </ul>
      <div className="rb-poker-table__actions">
        <span className="rb-poker-table__count" role="status">{t('poker.table.count', { voted, total: seats.length })}</span>
        {revealed
          ? <Button onClick={onReset}>{t('poker.reset')}</Button>
          : <Button variant={BUTTON_VARIANT.PRIMARY} disabled={voted === 0} onClick={onReveal}>{t('poker.reveal')}</Button>}
        {canNext && <Button onClick={onNext}>{t('poker.next')}</Button>}
      </div>
    </section>
  );
}
