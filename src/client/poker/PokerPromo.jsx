import React from 'react';
import { Surface } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT, SURFACE_KIND } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { PLANNING_POKER_PATH } from '../seo/seo-pages.js';
import StartPokerButton from './StartPokerButton.jsx';
import './poker.css';

// Home-page card that starts a Planning Poker room.
export default function PokerPromo() {
  return (
    <Surface role="region" aria-labelledby="landing-poker-title" kind={SURFACE_KIND.CARD} className="rb-landing__card rb-poker-promo">
      <h2 id="landing-poker-title" className="rb-landing__section-head">{t('landing.poker.head')}</h2>
      <p id="landing-poker-desc" className="rb-poker-promo__desc">{t('landing.poker.desc')}</p>
      <div className="rb-poker-promo__actions">
        {/* Secondary: the home page keeps one primary action, Create board. */}
        <StartPokerButton describedBy="landing-poker-desc" errorClassName="rb-poker-promo__error" variant={BUTTON_VARIANT.DEFAULT} />
        <a href={PLANNING_POKER_PATH}>{t('landing.poker.guide')}</a>
      </div>
    </Surface>
  );
}
