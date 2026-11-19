import React, { useState, useEffect } from 'react';
import {
  Sparkles, Plus, ArrowRight, Check, ChevronDown,
} from 'lucide-react';
import { ROOM_KIND, gotoBoard } from './router.js';
import RecentRooms, { useRecentRooms } from './RecentRooms.jsx';
import { t } from '../ui/i18n.js';
import { Button, Surface } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT, SURFACE_KIND } from '../ui/ui-variants.js';
import { parseJoinInput } from './join-input.js';
import { DISPLAY_NAME_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { APP_VIEWPORT_CONTENT } from '../ui/mobile-layout.js';
import { useCreateBoard } from './use-create-board.js';
import CreateBoardError from './CreateBoardError.jsx';
import GuestRoomNote from './GuestRoomNote.jsx';
import LandingGuide from './LandingGuide.jsx';
import FormatChips from './FormatChips.jsx';
import CreateLockedRoom from '../room-lock/CreateLockedRoom.jsx';
import PublicWallPreview from '../public-wall/PublicWallPreview.jsx';
import PokerFeature from '../poker/PokerFeature.jsx';
import { AGILE_GUIDE_PATH, PLANNING_POKER_PATH } from '../seo/seo-pages.js';
import { LEGAL_PAGE, LEGAL_PATH } from '../legal/legal-content.js';
import SiteMasthead from './SiteMasthead.jsx';
import { pageHref } from '../seo/page-links.js';
import LanguageLinks from '../seo/LanguageLinks.jsx';
import './landing.css';

const LANDING_ICON_SIZE_PX = Object.freeze({ ACTION: 16, TRUST: 14 });
const TRUST_KEYS = Object.freeze(['landing.trust.free', 'landing.trust.signup', 'landing.trust.realtime']);
export const RECENTS_SECTION_ID = 'landing-recents';
const LANDING_LINKS = Object.freeze([
  { href: '#landing-guide-templates', labelKey: 'landing.nav.templates' },
  { href: '#landing-guide-faq', labelKey: 'landing.nav.faq' },
  { href: PLANNING_POKER_PATH, labelKey: 'poker.title' },
  { href: AGILE_GUIDE_PATH, labelKey: 'agileGuide.nav.guide' },
]);

function useBlockBrowserZoom() {
  // Block browser zoom on Landing only — board has its own zoom logic.
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    const prevContent = meta?.getAttribute('content') || '';
    if (meta) {
      meta.setAttribute(
        'content',
        APP_VIEWPORT_CONTENT,
      );
    }

    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
    };
    const onGesture = (e) => e.preventDefault();

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('gesturestart', onGesture);
    window.addEventListener('gesturechange', onGesture);
    window.addEventListener('gestureend', onGesture);

    const baseDPR = window.devicePixelRatio || 1;
    const counterZoom = () => {
      const ratio = (window.devicePixelRatio || 1) / baseDPR;
      document.body.style.zoom = Math.abs(ratio - 1) > 0.01 ? String(1 / ratio) : '';
    };
    counterZoom();
    window.addEventListener('resize', counterZoom);
    window.visualViewport?.addEventListener('resize', counterZoom);

    return () => {
      if (meta) meta.setAttribute('content', prevContent);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('gesturestart', onGesture);
      window.removeEventListener('gesturechange', onGesture);
      window.removeEventListener('gestureend', onGesture);
      window.removeEventListener('resize', counterZoom);
      window.visualViewport?.removeEventListener('resize', counterZoom);
      document.body.style.zoom = '';
    };
  }, []);
}

function scrollToControlledSection(event) {
  event.preventDefault();
  const sectionId = event.currentTarget.getAttribute('aria-controls');
  const section = event.currentTarget.ownerDocument.getElementById(sectionId);
  section?.scrollIntoView({ block: 'start' });
  section?.focus({ preventScroll: true });
}

export default function Landing() {
  const [joinCode, setJoinCode] = useState('');
  const [boardName, setBoardName] = useState('');
  const { creating, createError, createBoard: createRoomAndOpen } = useCreateBoard();
  // Poker rooms are listed on the Planning Poker page instead.
  const { recents, remove: removeRecent } = useRecentRooms(ROOM_KIND.BOARD);
  useBlockBrowserZoom();

  const join = () => {
    const destination = parseJoinInput(joinCode);
    if (destination) gotoBoard(destination.code, destination.token);
  };
  const startFormat = (starter) => createRoomAndOpen({ name: boardName, starter });

  return (
    <div className="rb-landing__page" onContextMenu={(e) => e.preventDefault()}>
      <main className="rb-landing__content">
        <PublicWallPreview variant="hero" masthead={<SiteMasthead homeHref="/" BrandIcon={Sparkles} titleKey="app.title" links={LANDING_LINKS} />} belowHero={
          <>
            <div className="rb-landing__poker">
              <PokerFeature titleKey="landing.poker.head" ledeKey="landing.poker.desc" showGuideLink buttonVariant={BUTTON_VARIANT.DEFAULT} />
            </div>
            {recents.length > 0 && <RecentRooms id={RECENTS_SECTION_ID} recents={recents} onRemove={removeRecent} />}
            <LandingGuide onStartFormat={startFormat} creating={creating} createError={createError} />
            <LandingFooter />
          </>
        }>
          <div className="rb-landing__intro">
            <p className="rb-landing__eyebrow">{t('landing.hero.eyebrow')}</p>
            <h1 className="rb-landing__title" id="landing-hero-title">
              {t('landing.hero.title')}<span>{t('landing.hero.titleAccent')}</span>
            </h1>
            <p className="rb-landing__tagline">{t('app.tagline')}</p>
            <ul className="rb-landing__trust">
              {TRUST_KEYS.map((key) => <li key={key}><Check size={LANDING_ICON_SIZE_PX.TRUST} aria-hidden="true" />{t(key)}</li>)}
            </ul>
            <StartPanel boardName={boardName} onNameChange={setBoardName} creating={creating} error={createError}
              onCreate={() => createRoomAndOpen({ name: boardName })} onCreateLocked={createRoomAndOpen} onStartFormat={startFormat}
              joinCode={joinCode} onCodeChange={setJoinCode} onJoin={join} />
            {recents.length > 0 && (
              <a className="rb-landing__scroll-cue" href={`#${RECENTS_SECTION_ID}`} aria-controls={RECENTS_SECTION_ID}
                onClick={scrollToControlledSection}>
                {t('landing.recents.count', { count: recents.length })} <ChevronDown aria-hidden="true" />
              </a>
            )}
          </div>
        </PublicWallPreview>
      </main>
    </div>
  );
}

function LandingFooter() {
  return (
    <footer className="rb-landing__footer">
      <span className="rb-landing__footer-brand">
        <span className="rb-landing__brand rb-landing__brand--small"><Sparkles size={LANDING_ICON_SIZE_PX.ACTION} /></span>
        {t('app.title')}
      </span>
      <p>{t('landing.footer')}</p>
      <nav className="rb-landing__legal" aria-label={t('legal.footer.nav')}>
        <a href={pageHref(LEGAL_PATH[LEGAL_PAGE.PRIVACY])}>{t('legal.footer.privacy')}</a>
        <a href={pageHref(LEGAL_PATH[LEGAL_PAGE.TERMS])}>{t('legal.footer.terms')}</a>
      </nav>
      <LanguageLinks />
    </footer>
  );
}

function StartPanel({ boardName, onNameChange, onCreate, onCreateLocked, creating, error, onStartFormat, joinCode, onCodeChange, onJoin }) {
  return (
    <Surface kind={SURFACE_KIND.CARD} className="rb-landing__card rb-landing__start">
      <h2 className="rb-landing__section-head">{t('landing.create.head')}</h2>
      <p className="rb-landing__description">{t('landing.create.desc')}</p>
      <div className="rb-landing__form-row">
        <input
          className="rb-input rb-landing__input"
          aria-label={t('landing.create.head')}
          value={boardName}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !creating && onCreate()}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          placeholder={t('landing.create.namePlaceholder')}
        />
        <Button variant={BUTTON_VARIANT.PRIMARY} className="rb-landing__action" onClick={onCreate} disabled={creating}>
          <Plus size={LANDING_ICON_SIZE_PX.ACTION} />
          {creating ? t('landing.create.creating') : t('landing.create.btn')}
        </Button>
      </div>
      <CreateBoardError error={error} />
      <GuestRoomNote />
      <CreateLockedRoom boardName={boardName} createBoard={onCreateLocked} creating={creating} />
      <p className="rb-landing__chips-label">{t('landing.start.formats')}</p>
      <FormatChips onStart={onStartFormat} disabled={creating} />
      <JoinRow joinCode={joinCode} onCodeChange={onCodeChange} onJoin={onJoin} />
    </Surface>
  );
}

export function JoinRow({ joinCode, onCodeChange, onJoin }) {
  return (
    <div className="rb-landing__join">
      <p className="rb-landing__join-label" id="landing-join-label">{t('landing.join.or')}</p>
      <div className="rb-landing__form-row">
        <input
          className="rb-input rb-landing__input"
          aria-labelledby="landing-join-label"
          value={joinCode}
          onChange={(e) => onCodeChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onJoin()}
          placeholder={t('landing.join.placeholder')}
        />
        <Button
          variant={BUTTON_VARIANT.DEFAULT}
          className="rb-landing__action"
          onClick={onJoin}
          disabled={!joinCode.trim()}
        >
          {t('landing.join.btn')} <ArrowRight size={LANDING_ICON_SIZE_PX.ACTION} />
        </Button>
      </div>
    </div>
  );
}
