import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles, Plus, Clock, ArrowRight, Trash2, Languages, Sun, Moon, Monitor,
} from 'lucide-react';
import {
  gotoBoard, loadRecents, forgetRecent, markBoardCreated, rememberRecent,
} from './router.js';
import { t, useLang } from './i18n.js';
import { useTheme, nextThemePref } from './theme.js';
import { DISPLAY_NAME_MAX_LENGTH } from './security-boundaries.js';
import {
  ROOM_SESSION_ERROR,
  RoomSessionError,
  createRoom,
} from './room-session.js';

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
    // Accept a raw code OR a full share URL. If the input is a URL, keep its
    // hash so the token rides along to the board page.
    const raw = joinCode.trim();
    let token = null;
    let codeStr = raw;
    const hashIdx = codeStr.indexOf('#');
    if (hashIdx >= 0) {
      token = codeStr.slice(hashIdx + 1) || null;
      codeStr = codeStr.slice(0, hashIdx);
    }
    codeStr = codeStr
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^\/?b\//, '')
      .replace(/\/$/, '');
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(codeStr)) return;
    if (token && !/^[A-Za-z0-9_-]{8,64}$/.test(token)) token = null;
    gotoBoard(codeStr, token);
  };

  const fmtAgo = (ts) => {
    const diff = Date.now() - ts;
    if (diff < 60_000) return t('common.justNow');
    if (diff < 3600_000) return t('common.minutesAgo', { n: Math.floor(diff / 60000) });
    if (diff < 86_400_000) return t('common.hoursAgo', { n: Math.floor(diff / 3_600_000) });
    return t('common.daysAgo', { n: Math.floor(diff / 86_400_000) });
  };

  const ThemeIcon = themePref === 'auto' ? Monitor : themePref === 'dark' ? Moon : Sun;

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed', inset: 0, overflow: 'auto',
        background: 'var(--bg)',
        backgroundImage: 'radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
        fontFamily: '"Plus Jakarta Sans", "Sarabun", sans-serif',
        color: 'var(--text)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 20px', boxSizing: 'border-box',
      }}
    >
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Sarabun:wght@400;600;700&family=Caveat:wght@400;700&display=swap"
        rel="stylesheet"
      />

      {/* Top-right corner: lang + theme toggle */}
      <div style={{
        position: 'fixed', top: 16, right: 16, display: 'flex', gap: 8, zIndex: 10,
      }}
      >
        <button
          type="button"
          onClick={() => setLang(lang === 'th' ? 'en' : 'th')}
          title={t('settings.lang')}
          style={cornerBtn()}
        >
          <Languages size={14} />
          <span style={{ fontWeight: 700 }}>{lang === 'th' ? 'TH' : 'EN'}</span>
        </button>
        <button
          type="button"
          onClick={() => setThemePref(nextThemePref(themePref))}
          title={`${t('settings.theme')}: ${t(`settings.theme.${themePref}`)}`}
          style={cornerBtn()}
        >
          <ThemeIcon size={14} />
        </button>
      </div>

      <div style={{ width: '100%', maxWidth: 560 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <div style={{
            background: 'var(--accent)', color: '#fff', borderRadius: 12,
            width: 44, height: 44, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
          >
            <Sparkles size={22} />
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{t('app.title')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {t('app.tagline')}
            </div>
          </div>
        </div>

        {/* Create card */}
        <div style={cardStyle}>
          <div style={sectionHead}>{t('landing.create.head')}</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
            {t('landing.create.desc')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              placeholder={t('landing.create.namePlaceholder')}
              style={inputStyle}
            />
            <button
              type="button"
              onClick={createBoard}
              disabled={creating}
              style={{
                ...primaryBtn,
                cursor: creating ? 'not-allowed' : 'pointer',
                opacity: creating ? 0.65 : 1,
              }}
            >
              <Plus size={16} /> {creating ? t('landing.create.creating') : t('landing.create.btn')}
            </button>
          </div>
          {createError && (
            <div role="alert" style={{ marginTop: 10, color: 'var(--danger)', fontSize: 13 }}>
              {createError.code === ROOM_SESSION_ERROR.RATE_LIMITED
                ? t('landing.create.error.rateLimited', {
                  seconds: createError.retryAfterSeconds || 2,
                })
                : t('landing.create.error.unavailable')}
            </div>
          )}
        </div>

        {/* Join card */}
        <div style={cardStyle}>
          <div style={sectionHead}>{t('landing.join.head')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              placeholder={t('landing.join.placeholder')}
              style={inputStyle}
            />
            <button
              type="button"
              onClick={join}
              disabled={!joinCode.trim()}
              style={{
                ...primaryBtn,
                background: joinCode.trim() ? 'var(--text)' : 'var(--text-faint)',
                cursor: joinCode.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              {t('landing.join.btn')} <ArrowRight size={16} />
            </button>
          </div>
        </div>

        {/* Recents */}
        {recents.length > 0 && (
          <div style={cardStyle}>
            <div style={sectionHead}>
              <Clock size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
              {t('landing.recents.head')}
            </div>
            <div>
              {recents.map((r) => (
                <div
                  key={`${r.code}#${r.token || ''}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 10px', borderRadius: 8,
                    transition: 'background 0.1s',
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-panel-2)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <button
                    type="button"
                    onClick={() => gotoBoard(r.code, r.token)}
                    style={{
                      flex: 1, textAlign: 'left',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      padding: 0, color: 'var(--text)',
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}
                  >
                    <span style={{
                      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                      fontSize: 13, fontWeight: 700, color: 'var(--accent)',
                    }}
                    >
                      {r.code}
                    </span>
                    {r.name && (
                      <span style={{ fontSize: 13, color: 'var(--text-mid)' }}>{r.name}</span>
                    )}
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{fmtAgo(r.visitedAt)}</span>
                  <button
                    type="button"
                    onClick={() => { forgetRecent(r.code, r.token); setRecents(loadRecents()); }}
                    title={t('landing.recents.remove')}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--text-faint)', padding: 4, borderRadius: 4,
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-faint)', marginTop: 20 }}>
          {t('landing.footer')}
        </div>
      </div>
    </div>
  );
}

const cardStyle = {
  background: 'var(--bg-panel)',
  borderRadius: 14,
  padding: 20,
  marginBottom: 16,
  boxShadow: 'var(--shadow-card)',
};

const sectionHead = {
  fontSize: 14,
  fontWeight: 700,
  marginBottom: 10,
  color: 'var(--text)',
};

const inputStyle = {
  flex: 1,
  padding: '10px 14px',
  fontSize: 14,
  border: '1px solid var(--border)',
  borderRadius: 10,
  outline: 'none',
  background: 'var(--bg-panel)',
  color: 'var(--text)',
};

const primaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  borderRadius: 10,
  padding: '10px 16px',
  fontWeight: 700,
  fontSize: 14,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const cornerBtn = () => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'var(--bg-panel)',
  color: 'var(--text)',
  border: '1px solid var(--border-strong)',
  borderRadius: 999,
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
  boxShadow: 'var(--shadow-card)',
});
