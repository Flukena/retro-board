import React from 'react';
import { Button, ChoiceChip } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { rankedCards } from '../../domain/poker-deck.js';
import { POKER_SPREAD } from '../../domain/poker-round.js';
import { cardLabel, formatStat } from './poker-format.js';

const joinNames = (ids, names, fallback) => ids.map((id) => names.get(id) ?? fallback).join(', ');

function SpreadBadge({ summary, names }) {
  if (summary.consensus) return <p className="rb-poker-summary__badge rb-poker-summary__badge--agree">{t('poker.summary.consensus')}</p>;
  if (summary.spread === POKER_SPREAD.WIDE) {
    const guest = t('poker.guest');
    return (
      <p className="rb-poker-summary__badge rb-poker-summary__badge--wide">
        {t('poker.summary.wide', { low: joinNames(summary.lowVoterIds, names, guest), high: joinNames(summary.highVoterIds, names, guest) })}
      </p>
    );
  }
  if (summary.spread === POKER_SPREAD.CLOSE) return <p className="rb-poker-summary__badge">{t('poker.summary.close')}</p>;
  return null;
}

function Distribution({ distribution }) {
  const most = Math.max(...distribution.map((entry) => entry.count));
  return (
    <ul className="rb-poker-summary__bars">
      {distribution.map((entry) => (
        <li key={entry.cardId} className="rb-poker-summary__bar" style={{ '--rb-poker-bar-ratio': entry.count / most }}>
          <span className="rb-poker-summary__bar-label">{entry.label}</span>
          <span className="rb-poker-summary__bar-fill" aria-hidden="true" />
          <span className="rb-poker-summary__bar-count">{entry.count}</span>
        </li>
      ))}
    </ul>
  );
}

function EstimatePicker({ deck, summary, finalEstimate, onAccept }) {
  if (finalEstimate !== null) {
    return <p className="rb-poker-summary__final">{t('poker.summary.accepted', { value: cardLabel(deck, finalEstimate) })}</p>;
  }
  return (
    <div className="rb-poker-summary__accept">
      {summary.suggestedCardId !== null && (
        <Button variant={BUTTON_VARIANT.PRIMARY} onClick={() => onAccept(summary.suggestedCardId)}>
          {t('poker.summary.accept', { value: cardLabel(deck, summary.suggestedCardId) })}
        </Button>
      )}
      <div className="rb-poker-summary__chips">
        {rankedCards(deck).map((card) => (
          <ChoiceChip key={card.id} selected={false} onClick={() => onAccept(card.id)}>{card.label}</ChoiceChip>
        ))}
      </div>
    </div>
  );
}

export function RoundSummary({ summary, deck, names, finalEstimate, onAccept }) {
  if (summary.voterCount === 0) return <section className="rb-poker-summary"><p>{t('poker.summary.noVotes')}</p></section>;
  return (
    <section className="rb-poker-summary" aria-live="polite">
      <dl className="rb-poker-summary__stats">
        <div><dt>{t('poker.summary.average')}</dt><dd>{formatStat(summary.average)}</dd></div>
        <div><dt>{t('poker.summary.median')}</dt><dd>{formatStat(summary.median)}</dd></div>
        <div><dt>{t('poker.summary.votes')}</dt><dd>{summary.voterCount}</dd></div>
      </dl>
      <SpreadBadge summary={summary} names={names} />
      <Distribution distribution={summary.distribution} />
      <EstimatePicker deck={deck} summary={summary} finalEstimate={finalEstimate} onAccept={onAccept} />
    </section>
  );
}
