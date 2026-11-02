import React from 'react';
import { t, useLang } from '../ui/i18n.js';
import SitePage, { SiteLinks } from '../app/SitePage.jsx';
import PokerFeature from './PokerFeature.jsx';
import RecentRooms, { useRecentRooms } from '../app/RecentRooms.jsx';
import { ROOM_KIND } from '../app/router.js';
import './poker.css';

const POKER_RECENTS_ID = 'poker-recents';
const STEP_KEYS = Object.freeze(['pokerPage.step1', 'pokerPage.step2', 'pokerPage.step3', 'pokerPage.step4', 'pokerPage.step5']);

// Home of Planning Poker: start a room, reopen your recent poker rooms, and the indexable how-to guide.
export default function PokerGuidePage() {
  useLang();
  const { recents, remove } = useRecentRooms(ROOM_KIND.POKER);
  return (
    <SitePage labelledBy="poker-feature-title" className="rb-template">
      <PokerFeature Heading="h1" titleKey="pokerPage.heading" ledeKey="pokerPage.lede" noteKey="pokerPage.startNote" />
      {recents.length > 0 && <RecentRooms id={POKER_RECENTS_ID} recents={recents} onRemove={remove} />}
      <section className="rb-legal__section" aria-labelledby="poker-guide-how">
        <h2 id="poker-guide-how">{t('pokerPage.section.how')}</h2>
        <ol className="rb-template__list">{STEP_KEYS.map((key) => <li key={key}>{t(key)}</li>)}</ol>
      </section>
      <section className="rb-legal__section" aria-labelledby="poker-guide-decks">
        <h2 id="poker-guide-decks">{t('pokerPage.section.decks')}</h2>
        <p>{t('pokerPage.decks')}</p>
      </section>
      <section className="rb-legal__section" aria-labelledby="poker-guide-why">
        <h2 id="poker-guide-why">{t('pokerPage.section.why')}</h2>
        <p>{t('pokerPage.why')}</p>
      </section>
      <section className="rb-legal__section" aria-labelledby="poker-guide-more">
        <h2 id="poker-guide-more">{t('tpl.section.more')}</h2>
        <SiteLinks />
      </section>
    </SitePage>
  );
}
