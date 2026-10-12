import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles, Plus, ArrowRight, X, Languages, Sun, Moon, Monitor,
} from 'lucide-react';
import {
  gotoBoard, loadRecents, forgetRecent, markBoardCreated, rememberRecent,
} from './router.js';
import { t, useLang } from './i18n.js';
import { useTheme, nextThemePref } from './theme.js';
import { Button, IconButton, Surface } from './UiPrimitives.jsx';
import { BUTTON_VARIANT, SURFACE_KIND } from './ui-variants.js';
import { TOPBAR_ICON_SIZE_PX } from './chrome-layout.js';
import { formatRelativeTime } from './relative-time.js';
import { parseJoinInput } from './join-input.js';
import { DISPLAY_NAME_MAX_LENGTH } from './security-boundaries.js';
import {
  ROOM_SESSION_ERROR,
  RoomSessionError,
  createRoom,
} from './room-session.js';
import './landing.css';

const CREATE_RETRY_FALLBACK_SECONDS = 2;
const LANDING_ICON_SIZE_PX = Object.freeze({ BRAND: 22, ACTION: 16, REMOVE: 15 });
const THEME_ICONS = Object.freeze({ auto: Monitor, dark: Moon, light: Sun });

export default function Landing() {
  const [recents, setRecents] = useState([]);
  const [joinCode, setJoinCode] = useState('');
  const [boardName, setBoardName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const creatingRef = useRef(false);
  const [lang, setLang] = useLang();
  const { pref: themePref, setThemePref } = useTheme();

  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  // Block browser zoom on Landing only — board has its own zoom logic.
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    const prevContent = meta?.getAttribute('content') || '';
    if (meta) {
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no',
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

  const createBoard = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      // The relay, not the browser, allocates and registers the room. Only
      // after a successful 201 do we remember creator status and navigate.
      const { code, token } = await createRoom();
      markBoardCreated(code, token);
      rememberRecent(code, boardName, token);
      gotoBoard(code, token);
    } catch (error) {
      const rateLimited = error instanceof RoomSessionError
        && error.code === ROOM_SESSION_ERROR.RATE_LIMITED;
      setCreateError({
        code: rateLimited ? ROOM_SESSION_ERROR.RATE_LIMITED : ROOM_SESSION_ERROR.UNAVAILABLE,
        retryAfterSeconds: rateLimited ? error.retryAfterSeconds : null,
      });
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const join = () => {
    const destination = parseJoinInput(joinCode);
    if (destination) gotoBoard(destination.code, destination.token);
  };

  const removeRecent = (code, token) => {
    forgetRecent(code, token);
    setRecents(loadRecents());
  };

  return (
    <div
      className="rb-landing__page"
      onContextMenu={(e) => e.preventDefault()}
    >
      <CornerToggles
        lang={lang}
        themePref={themePref}
        onLanguage={() => setLang(lang === 'th' ? 'en' : 'th')}
        onTheme={() => setThemePref(nextThemePref(themePref))}
      />
      <div className="rb-landing__content">
        <div className="rb-landing__hero">
          <div className="rb-landing__brand">
            <Sparkles size={LANDING_ICON_SIZE_PX.BRAND} />
          </div>
          <div>
            <div className="rb-landing__title">{t('app.title')}</div>
            <div className="rb-landing__tagline">{t('app.tagline')}</div>
          </div>
        </div>
        <CreateCard
          boardName={boardName}
          onNameChange={setBoardName}
          onCreate={createBoard}
          creating={creating}
          error={createError}
        />
        <JoinCard joinCode={joinCode} onCodeChange={setJoinCode} onJoin={join} />
        {recents.length > 0 && (
          <Surface kind={SURFACE_KIND.CARD} className="rb-landing__card rb-landing__card--recents">
            <div className="rb-landing__section-head">
              {t('landing.recents.head')}
            </div>
            {recents.map((recent) => (
              <RecentRow
                key={`${recent.code}#${recent.token || ''}`}
                recent={recent}
                onRemove={removeRecent}
              />
            ))}
          </Surface>
        )}
        <div className="rb-landing__footer">{t('landing.footer')}</div>
      </div>
    </div>
  );
}

function CornerToggles({ lang, themePref, onLanguage, onTheme }) {
  const ThemeIcon = THEME_ICONS[themePref];
  const themeTitle = `${t('settings.theme')}: ${t(`settings.theme.${themePref}`)}`;
  return (
    <div className="rb-landing__corner">
      <Button className="rb-btn--pill" onClick={onLanguage} title={t('settings.lang')}>
        <Languages size={TOPBAR_ICON_SIZE_PX.TOGGLE} />
        {t(`settings.lang.${lang}`)}
      </Button>
      <Button
        className="rb-btn--pill"
        onClick={onTheme}
        title={themeTitle}
        aria-label={themeTitle}
      >
        <ThemeIcon size={TOPBAR_ICON_SIZE_PX.TOGGLE} />
      </Button>
    </div>
  );
}

function CreateCard({ boardName, onNameChange, onCreate, creating, error }) {
  return (
    <Surface kind={SURFACE_KIND.CARD} className="rb-landing__card">
      <div className="rb-landing__section-head">{t('landing.create.head')}</div>
      <div className="rb-landing__description">{t('landing.create.desc')}</div>
      <div className="rb-landing__form-row">
        <input
          className="rb-input rb-landing__input"
          value={boardName}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          placeholder={t('landing.create.namePlaceholder')}
        />
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          className="rb-landing__action"
          onClick={onCreate}
          disabled={creating}
        >
          <Plus size={LANDING_ICON_SIZE_PX.ACTION} />
          {creating ? t('landing.create.creating') : t('landing.create.btn')}
        </Button>
      </div>
      {error && (
        <div role="alert" className="rb-landing__error">
          {error.code === ROOM_SESSION_ERROR.RATE_LIMITED
            ? t('landing.create.error.rateLimited', {
              seconds: error.retryAfterSeconds || CREATE_RETRY_FALLBACK_SECONDS,
            })
            : t('landing.create.error.unavailable')}
        </div>
      )}
    </Surface>
  );
}

export function JoinCard({ joinCode, onCodeChange, onJoin }) {
  return (
    <Surface kind={SURFACE_KIND.CARD} className="rb-landing__card">
      <div className="rb-landing__section-head">{t('landing.join.head')}</div>
      <div className="rb-landing__form-row">
        <input
          className="rb-input rb-landing__input"
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
    </Surface>
  );
}

export function RecentRow({ recent, onRemove }) {
  const removeLabel = t('landing.recents.remove');
  return (
    <div className="rb-landing__recent">
      <button
        type="button"
        className="rb-landing__recent-open"
        onClick={() => gotoBoard(recent.code, recent.token)}
      >
        <span className="rb-landing__recent-name">{recent.name || recent.code}</span>
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
        <X size={LANDING_ICON_SIZE_PX.REMOVE} />
      </IconButton>
    </div>
  );
}
