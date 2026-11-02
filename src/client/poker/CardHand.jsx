import React from 'react';
import { Check } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { cardTitle } from './poker-format.js';

const BADGE_ICON_SIZE_PX = 13;

// The viewer's row of cards. Picking the selected card again takes the vote back.
export function CardHand({ deck, selectedCardId, locked, disabled, onPick }) {
  return (
    <section className="rb-poker-hand" aria-label={t('poker.hand.label')}>
      {locked && <p className="rb-poker-hand__note">{t('poker.hand.locked')}</p>}
      <div className="rb-poker-hand__cards">
        {deck.cards.map((card) => {
          const selected = card.id === selectedCardId;
          return (
            <button
              key={card.id}
              type="button"
              className={selected ? 'rb-poker-card rb-poker-card--selected' : 'rb-poker-card'}
              aria-pressed={selected}
              aria-label={cardTitle(card, t)}
              title={cardTitle(card, t)}
              disabled={locked || disabled}
              onClick={() => onPick(selected ? null : card.id)}
            >
              <span className="rb-poker-card__corner" aria-hidden="true">{card.label}</span>
              <span className="rb-poker-card__face">{card.label}</span>
              <span className="rb-poker-card__corner rb-poker-card__corner--end" aria-hidden="true">{card.label}</span>
              {selected && <span className="rb-poker-card__badge" aria-hidden="true"><Check size={BADGE_ICON_SIZE_PX} /></span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
