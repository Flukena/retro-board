import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Globe2, PenLine } from 'lucide-react';
import { t, useLang } from '../ui/i18n.js';
import { useTheme } from '../ui/theme.js';
import { publicWallView, PUBLIC_SCENE_WIDTH_PX, PUBLIC_SCENE_HEIGHT_PX } from './public-wall-view.js';
import { PublicWallSnapshotScene } from './PublicWallSnapshotScene.jsx';
import { usePublicWallSnapshotImage } from './use-public-wall-snapshot-image.js';
import { useBrowserLayoutEffect } from '../ui/use-browser-layout-effect.js';
import { PUBLIC_PATH, PUBLIC_RELAY_PREFIX, PUBLIC_SNAPSHOT_INTERVAL_MS, PUBLIC_SNAPSHOT_ROUTE } from '../../domain/public-wall-contract.js';
import '../board/public-wall.css';

function usePreviewScale(previewRef) {
  const [scale, setScale] = useState(1);
  useBrowserLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;
    const measure = () => {
      if (preview.clientWidth > 0) setScale(preview.clientWidth / PUBLIC_SCENE_WIDTH_PX);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(preview);
    measure();
    return () => observer?.disconnect();
  }, [previewRef]);
  return scale;
}

export function PublicWallPreviewFrame({ snapshot, lang, sceneRef, imageUrl }) {
  const previewRef = useRef(null);
  const scale = usePreviewScale(previewRef);
  return (
    <a ref={previewRef} className="rb-public-wall__preview" href={PUBLIC_PATH} aria-label={t('public.join')}
      style={{ '--rb-public-preview-scale': scale, '--rb-public-scene-width-px': `${PUBLIC_SCENE_WIDTH_PX}px`,
        '--rb-public-scene-height-px': `${PUBLIC_SCENE_HEIGHT_PX}px`,
        '--rb-public-scene-aspect-ratio': `${PUBLIC_SCENE_WIDTH_PX} / ${PUBLIC_SCENE_HEIGHT_PX}` }}>
      {imageUrl && <img className="rb-public-wall__image" src={imageUrl} alt={t('public.title')} draggable={false} />}
      <div className={`rb-public-wall__capture${imageUrl ? ' rb-public-wall__capture--offscreen' : ''}`}>
        <PublicWallSnapshotScene snapshot={snapshot} sceneRef={sceneRef} lang={lang} />
      </div>
    </a>
  );
}

function heroCaptionKey(hasItems, status) {
  if (status !== 'ready') return `public.${status}`;
  return hasItems ? 'public.description' : 'public.empty';
}

const MS_PER_SECOND = 1000;
const SNAPSHOT_INTERVAL_SECONDS = PUBLIC_SNAPSHOT_INTERVAL_MS / MS_PER_SECOND;

// Live view of the Public Wall in the hero, so visitors see it before joining.
function PublicWallWindow({ snapshot, status, hasItems, lang, sceneRef, image }) {
  const live = status === 'ready' && hasItems;
  return (
    <section className="rb-landing__wall" aria-labelledby="landing-wall-title">
      <div className="rb-landing__wall-head">
        <span className="rb-landing__public-icon"><Globe2 aria-hidden="true" /></span>
        <div className="rb-landing__wall-copy">
          <h2 id="landing-wall-title">{t('public.title')}</h2>
          <p>{t('public.description')}</p>
        </div>
        {live && <span className="rb-landing__live"><span aria-hidden="true" />{t('public.live')}</span>}
      </div>
      {hasItems
        ? <PublicWallPreviewFrame snapshot={snapshot} lang={lang} sceneRef={sceneRef} imageUrl={image.imageUrl} />
        : <a className="rb-landing__wall-empty" href={PUBLIC_PATH}><PenLine aria-hidden="true" />{t(heroCaptionKey(hasItems, status))}</a>}
      <p className="rb-landing__wall-note" role={live ? undefined : 'status'}>
        {live ? t('public.updates', { seconds: SNAPSHOT_INTERVAL_SECONDS }) : t('public.openHint')}
      </p>
    </section>
  );
}

// The masthead scrolls with the page; the Public dock stays pinned below the scroll pane.
function PublicWallHero({ children, belowHero, masthead, ...wall }) {
  return (
    <>
      <div className="rb-landing__scroll">
        <section className="rb-landing__hero" aria-labelledby="landing-hero-title">
          {masthead}
          <div className="rb-landing__hero-layout">{children}<PublicWallWindow {...wall} /></div>
        </section>
        {belowHero}
      </div>
      <div className="rb-landing__public-bar">
        <span className="rb-landing__public-icon"><Globe2 aria-hidden="true" /></span>
        <div className="rb-landing__public-copy">
          <h2>{t('public.title')}</h2>
          <p>{t(heroCaptionKey(wall.hasItems, wall.status))}</p>
        </div>
        <a className="rb-btn rb-public-wall__join" href={PUBLIC_PATH}>
          {t('public.join')} <ArrowUpRight aria-hidden="true" />
        </a>
      </div>
    </>
  );
}

export function PublicWallPreviewContent({ snapshot, status = 'ready', variant = 'card', children, belowHero, masthead }) {
  const [lang] = useLang();
  const { resolved } = useTheme();
  const sceneRef = useRef(null);
  const view = publicWallView(snapshot);
  const revision = JSON.stringify([view.items, lang, resolved]);
  const image = usePublicWallSnapshotImage(sceneRef, revision, snapshot);
  if (variant === 'hero') return <PublicWallHero snapshot={snapshot} status={status} hasItems={view.items.length > 0}
    lang={lang} sceneRef={sceneRef} image={image} belowHero={belowHero} masthead={masthead}>{children}</PublicWallHero>;
  return (
    <section className="rb-landing__card rb-public-wall" aria-label={t('public.title')}>
      <h2 className="rb-landing__section-head">{t('public.title')}</h2>
      <p className="rb-landing__description">{t('public.description')}</p>
      {view.items.length ? <PublicWallPreviewFrame snapshot={snapshot} lang={lang}
        sceneRef={sceneRef} imageUrl={image.imageUrl} />
        : <p className="rb-public-wall__status" role="status">{t(`public.${status === 'ready' ? 'empty' : status}`)}</p>}
      {view.items.length > 0 && image.status === 'unavailable' && !image.imageUrl
        && <p className="rb-public-wall__status" role="status">{t('public.snapshotFallback')}</p>}
      {view.items.length > 0 && status === 'unavailable' && <p role="status">{t('public.unavailable')}</p>}
      <a className="rb-btn rb-btn--primary rb-public-wall__join" href={PUBLIC_PATH}>{t('public.join')}</a>
    </section>
  );
}

export default function PublicWallPreview({ variant = 'card', children, belowHero, masthead }) {
  const [state, setState] = useState({ snapshot: null, status: 'loading' });
  useEffect(() => {
    let stopped = false;
    let timer;
    let controller;
    const poll = async () => {
      controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), PUBLIC_SNAPSHOT_INTERVAL_MS);
      try {
        const response = await fetch(`${PUBLIC_RELAY_PREFIX}${PUBLIC_SNAPSHOT_ROUTE}`, {
          signal: controller.signal, credentials: 'omit', redirect: 'error',
        });
        if (!response.ok) throw new Error('Public snapshot unavailable');
        const snapshot = await response.json();
        if (!stopped) setState({ snapshot, status: 'ready' });
      } catch {
        if (!stopped) setState(previous => ({ ...previous, status: 'unavailable' }));
      } finally {
        clearTimeout(deadline);
        if (!stopped) timer = setTimeout(poll, PUBLIC_SNAPSHOT_INTERVAL_MS);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  return <PublicWallPreviewContent {...state} variant={variant} belowHero={belowHero} masthead={masthead}>{children}</PublicWallPreviewContent>;
}
