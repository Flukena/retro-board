import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, Globe2 } from 'lucide-react';
import { t, useLang } from '../ui/i18n.js';
import { useTheme } from '../ui/theme.js';
import { publicWallView, PUBLIC_SCENE_WIDTH_PX, PUBLIC_SCENE_HEIGHT_PX } from './public-wall-view.js';
import { PublicWallSnapshotScene } from './PublicWallSnapshotScene.jsx';
import { usePublicWallSnapshotImage } from './use-public-wall-snapshot-image.js';
import { useBrowserLayoutEffect } from '../ui/use-browser-layout-effect.js';
import { PUBLIC_PATH, PUBLIC_RELAY_PREFIX, PUBLIC_SNAPSHOT_INTERVAL_MS, PUBLIC_SNAPSHOT_ROUTE } from '../../domain/public-wall-contract.js';
import '../board/public-wall.css';

function usePreviewScale(previewRef, cover) {
  const [scale, setScale] = useState(1);
  useBrowserLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;
    const measure = () => {
      if (preview.clientWidth > 0) setScale(Math.max(preview.clientWidth / PUBLIC_SCENE_WIDTH_PX,
        cover ? preview.clientHeight / PUBLIC_SCENE_HEIGHT_PX : 0));
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(preview);
    measure();
    return () => observer?.disconnect();
  }, [previewRef, cover]);
  return scale;
}

export function PublicWallPreviewFrame({ snapshot, lang, sceneRef, imageUrl, decorative = false }) {
  const previewRef = useRef(null);
  const scale = usePreviewScale(previewRef, decorative);
  const PreviewRoot = decorative ? 'div' : 'a';
  return (
    <PreviewRoot ref={previewRef} className="rb-public-wall__preview" href={decorative ? undefined : PUBLIC_PATH}
      aria-label={decorative ? undefined : t('public.title')}
      style={{ '--rb-public-preview-scale': scale, '--rb-public-scene-width-px': `${PUBLIC_SCENE_WIDTH_PX}px`,
        '--rb-public-scene-height-px': `${PUBLIC_SCENE_HEIGHT_PX}px`,
        '--rb-public-scene-aspect-ratio': `${PUBLIC_SCENE_WIDTH_PX} / ${PUBLIC_SCENE_HEIGHT_PX}` }}>
      {imageUrl && <img className="rb-public-wall__image" src={imageUrl} alt={decorative ? '' : t('public.title')} draggable={false} />}
      <div className={`rb-public-wall__capture${imageUrl ? ' rb-public-wall__capture--offscreen' : ''}`}>
        <PublicWallSnapshotScene snapshot={snapshot} sceneRef={sceneRef} lang={lang} />
      </div>
    </PreviewRoot>
  );
}

function heroCaptionKey(hasItems, status) {
  if (status !== 'ready') return `public.${status}`;
  return hasItems ? 'public.description' : 'public.empty';
}

function scrollToControlledSection(event) {
  event.preventDefault();
  const sectionId = event.currentTarget.getAttribute('aria-controls');
  const section = event.currentTarget.ownerDocument.getElementById(sectionId);
  section?.scrollIntoView({ block: 'start' });
  section?.focus({ preventScroll: true });
}

function PublicWallHero({ snapshot, status, hasItems, lang, sceneRef, image, children, belowHero }) {
  const caption = heroCaptionKey(hasItems, status);
  return (
    <>
      <div className="rb-landing__scroll">
        <section className="rb-landing__hero" aria-labelledby="landing-hero-title">
          <div className="rb-landing__backdrop" aria-hidden="true">
            {hasItems && <PublicWallPreviewFrame snapshot={snapshot} lang={lang} sceneRef={sceneRef}
              imageUrl={image.imageUrl} decorative />}
          </div>
          <div className="rb-landing__hero-layout">{children}</div>
        </section>
        {belowHero}
      </div>
      <div className="rb-landing__public-bar">
        {belowHero && <a className="rb-landing__scroll-cue" href="#landing-recents" aria-controls="landing-recents" onClick={scrollToControlledSection}>
          {t('landing.recents.scroll')} <ChevronDown aria-hidden="true" />
        </a>}
        <div className="rb-landing__public-row">
          <span className="rb-landing__public-icon"><Globe2 aria-hidden="true" /></span>
          <div className="rb-landing__public-copy">
            <h2>{t('public.title')}</h2>
            <p role={status === 'ready' && hasItems ? undefined : 'status'}>{t(caption)}</p>
          </div>
          <a className="rb-btn rb-btn--primary rb-public-wall__join" href={PUBLIC_PATH}>
            {t('public.join')} <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </div>
    </>
  );
}

export function PublicWallPreviewContent({ snapshot, status = 'ready', variant = 'card', children, belowHero }) {
  const [lang] = useLang();
  const { resolved } = useTheme();
  const sceneRef = useRef(null);
  const view = publicWallView(snapshot);
  const revision = JSON.stringify([view.items, lang, resolved]);
  const image = usePublicWallSnapshotImage(sceneRef, revision, snapshot);
  if (variant === 'hero') return <PublicWallHero snapshot={snapshot} status={status} hasItems={view.items.length > 0}
    lang={lang} sceneRef={sceneRef} image={image} belowHero={belowHero}>{children}</PublicWallHero>;
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

export default function PublicWallPreview({ variant = 'card', children, belowHero }) {
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
  return <PublicWallPreviewContent {...state} variant={variant} belowHero={belowHero}>{children}</PublicWallPreviewContent>;
}
