import React from 'react';
import { Check } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { PLANNING_POKER_PATH } from '../seo/seo-pages.js';
import StartPokerButton from './StartPokerButton.jsx';
import './poker.css';

const POINT_KEYS = Object.freeze(['pokerFeature.point1', 'pokerFeature.point2', 'pokerFeature.point3']);
const FAN_CARDS = Object.freeze(['2', '3', '5', '8', '13']);
const FAN_SELECTED_INDEX = 2;
const POINT_ICON_SIZE_PX = 16;

function CardFan() {
  return (
    <div className="rb-poker-feature__fan" aria-hidden="true">
      {FAN_CARDS.map((label, index) => (
        <span key={label} style={{ '--rb-fan-offset': index - FAN_SELECTED_INDEX, '--rb-fan-distance': Math.abs(index - FAN_SELECTED_INDEX) }}
          className={index === FAN_SELECTED_INDEX ? 'rb-poker-feature__card rb-poker-feature__card--picked' : 'rb-poker-feature__card'}>
          {label}
        </span>
      ))}
    </div>
  );
}

// Planning Poker showcase: the home page's lead feature and the hero of /planning-poker.
// On the home page the button is secondary: its hero keeps one primary action, Create board.
export default function PokerFeature({
  Heading = 'h2', titleKey, ledeKey, noteKey = null, showGuideLink = false, buttonVariant = BUTTON_VARIANT.PRIMARY,
}) {
  return (
    <section className="rb-poker-feature" aria-labelledby="poker-feature-title">
      <div className="rb-poker-feature__copy">
        <p className="rb-poker-feature__eyebrow">{t('pokerFeature.eyebrow')}</p>
        <Heading id="poker-feature-title" className="rb-poker-feature__title">{t(titleKey)}</Heading>
        <p id="poker-feature-lede" className="rb-poker-feature__lede">{t(ledeKey)}</p>
        <ul className="rb-poker-feature__points">
          {POINT_KEYS.map((key) => <li key={key}><Check size={POINT_ICON_SIZE_PX} aria-hidden="true" />{t(key)}</li>)}
        </ul>
        <div className="rb-poker-feature__actions">
          <StartPokerButton describedBy="poker-feature-lede" errorClassName="rb-poker-feature__error" variant={buttonVariant} />
          {showGuideLink && <a href={PLANNING_POKER_PATH}>{t('landing.poker.guide')}</a>}
          {noteKey && <p className="rb-poker-feature__note">{t(noteKey)}</p>}
        </div>
      </div>
      <CardFan />
    </section>
  );
}
