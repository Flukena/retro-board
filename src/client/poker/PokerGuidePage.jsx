import React from 'react';
import { Sparkles, Spade } from 'lucide-react';
import { t, useLang } from '../ui/i18n.js';
import { SiteLinks } from '../app/SitePage.jsx';
import SiteMasthead from '../app/SiteMasthead.jsx';
import { Surface } from '../ui/UiPrimitives.jsx';
import { SURFACE_KIND } from '../ui/ui-variants.js';
import PokerFeature from './PokerFeature.jsx';
import RecentRooms, { useRecentRooms } from '../app/RecentRooms.jsx';
import { ROOM_KIND } from '../app/router.js';
import { PLANNING_POKER_PATH } from '../seo/seo-pages.js';
import { pageHref } from '../seo/page-links.js';
import LanguageLinks from '../seo/LanguageLinks.jsx';
import '../legal/legal.css';
import './poker.css';

const POKER_RECENTS_ID = 'poker-recents';
const RETRO_HOME_PATH = '/';
const RETRO_ICON_SIZE_PX = 16;
const STEP_KEYS = Object.freeze(['pokerPage.step1', 'pokerPage.step2', 'pokerPage.step3', 'pokerPage.step4', 'pokerPage.step5']);
const SECTION_ID = Object.freeze({ HOW: 'poker-guide-how', DECKS: 'poker-guide-decks', WHY: 'poker-guide-why', MORE: 'poker-guide-more' });
const POKER_LINKS = Object.freeze([
  { href: `#${SECTION_ID.HOW}`, labelKey: 'pokerPage.section.how' },
  { href: `#${SECTION_ID.DECKS}`, labelKey: 'pokerPage.section.decks' },
]);

function GuideSection({ id, titleKey, children }) {
  return (
    <section className="rb-legal__section" aria-labelledby={id}>
      <h2 id={id}>{t(titleKey)}</h2>
      {children}
    </section>
  );
}

// Planning Poker's own home: its own top bar with a way back to the retro board,
// the start card, your recent poker rooms, and the indexable how-to guide.
export default function PokerGuidePage() {
  useLang();
  const { recents, remove } = useRecentRooms(ROOM_KIND.POKER);
  const retroLink = (
    <a className="rb-btn rb-btn--pill rb-poker-home__retro" href={pageHref(RETRO_HOME_PATH)} aria-label={t('pokerPage.retroLink')} title={t('pokerPage.retroLink')}>
      <Sparkles size={RETRO_ICON_SIZE_PX} aria-hidden="true" />
      <span className="rb-poker-home__retro-label">{t('pokerPage.retroLink')}</span>
    </a>
  );
  return (
    <div className="rb-landing__page">
      <div className="rb-landing__content rb-poker-home">
        <SiteMasthead homeHref={PLANNING_POKER_PATH} BrandIcon={Spade} titleKey="poker.title" links={POKER_LINKS} action={retroLink} />
        <main className="rb-poker-home__main" aria-labelledby="poker-feature-title">
          <PokerFeature Heading="h1" titleKey="pokerPage.heading" ledeKey="pokerPage.lede" noteKey="pokerPage.startNote" />
          {recents.length > 0 && <RecentRooms id={POKER_RECENTS_ID} recents={recents} onRemove={remove} />}
          <Surface kind={SURFACE_KIND.CARD} className="rb-landing__card rb-poker-home__guide">
            <GuideSection id={SECTION_ID.HOW} titleKey="pokerPage.section.how">
              <ol className="rb-template__list">{STEP_KEYS.map((key) => <li key={key}>{t(key)}</li>)}</ol>
            </GuideSection>
            <GuideSection id={SECTION_ID.DECKS} titleKey="pokerPage.section.decks"><p>{t('pokerPage.decks')}</p></GuideSection>
            <GuideSection id={SECTION_ID.WHY} titleKey="pokerPage.section.why"><p>{t('pokerPage.why')}</p></GuideSection>
            <GuideSection id={SECTION_ID.MORE} titleKey="tpl.section.more"><SiteLinks /></GuideSection>
          </Surface>
        </main>
        <footer className="rb-landing__footer"><LanguageLinks /></footer>
      </div>
    </div>
  );
}
