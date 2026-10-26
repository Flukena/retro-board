import React, { useMemo, useRef, useState } from 'react';
import { OverviewRasterContext } from './overview-raster-context.js';
import { overviewRasterModel, overviewPaintRuns, OVERVIEW_RASTER_MAX_PIXELS, OVERVIEW_RASTER_MAX_DPR } from './overview-raster-model.js';
import { OverviewRasterPainter, overviewFontLoadAffectsPaint } from './overview-raster-paint.js';
import { OverviewRasterImage } from './overview-raster-image.js';
import { webkitCompositing } from './webkit-compositing.js';
import { t } from '../ui/i18n.js';
import { useBrowserLayoutEffect as useLayoutEffect } from '../ui/use-browser-layout-effect.js';

function RasterGroup({ items, compact, dense, selectedIds, remoteSelectors, focusedTextId, detailedIds,
  contexts, allRevealed, userId, winners, lang, pixelBudget, children }) {
  const atlasRef = useRef(null), painterRef = useRef(null), imageRef = useRef(null);
  const [paintedModel, setPaintedModel] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const asImage = webkitCompositing(globalThis);
  const enabled = dense && (compact || detailedIds != null) && !selectedIds.size && !remoteSelectors.size && !focusedTextId;
  const model = useMemo(() => enabled ? overviewRasterModel(items, { contexts, allRevealed, userId, winners,
    hiddenText: t('sticky.hidden'), maxPixels: pixelBudget, dpr: Math.min(globalThis.devicePixelRatio || 1, OVERVIEW_RASTER_MAX_DPR) }) : null,
  [items, enabled, contexts, allRevealed, userId, winners, lang, pixelBudget]);
  useLayoutEffect(() => {
    const atlas = atlasRef.current;
    if (!model || !atlas) { painterRef.current = null; setPaintedModel(null); return undefined; }
    // On WebKit the canvas stays out of the document; an image shows its pixels.
    const canvas = asImage ? atlas.ownerDocument.createElement('canvas') : atlas;
    const image = asImage ? new OverviewRasterImage(canvas, { onChange: setImageUrl }) : null;
    imageRef.current = image;
    const painter = new OverviewRasterPainter(canvas, model); painterRef.current = painter;
    let paintedFontFamily = '';
    const paint = () => {
      const style = getComputedStyle(atlas);
      paintedFontFamily = style.fontFamily;
      const ready = painter.draw({ fontFamily: style.fontFamily,
        padding: Number.parseFloat(style.getPropertyValue('--sticky-padding')),
        lineHeight: Number.parseFloat(style.getPropertyValue('--sticky-line-height')) });
      if (!image) setPaintedModel(ready ? model : null);
      else if (ready) image.publish();
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const paintFonts = event => { if (overviewFontLoadAffectsPaint(event, paintedFontFamily)) paint(); };
    document.fonts?.addEventListener('loadingdone', paintFonts);
    return () => {
      observer.disconnect(); document.fonts?.removeEventListener('loadingdone', paintFonts);
      painterRef.current = null; imageRef.current = null;
      if (image) { image.dispose(); setImageUrl(null); setPaintedModel(null); } else { canvas.width = 0; canvas.height = 0; }
    };
  }, [model, asImage]);
  useLayoutEffect(() => {
    painterRef.current?.setHidden(detailedIds);
    painterRef.current?.hover(hoveredId);
    imageRef.current?.publish();
  }, [hoveredId, detailedIds, model]);
  // Native card text is hidden only once the image showing it has loaded.
  const imageLoaded = event => { if (imageRef.current?.loaded(event.currentTarget.src)) setPaintedModel(model); };
  const bounds = model && { left: model.bounds.x, top: model.bounds.y, width: model.bounds.w, height: model.bounds.h };
  return (
    <OverviewRasterContext.Provider value={model && model === paintedModel ? model.ids : null}>
      <div className="rb-overview-layer" onMouseOver={event => setHoveredId(event.target.closest?.('[data-sticky-id]')?.dataset.stickyId || null)}
        onMouseLeave={() => setHoveredId(null)}>
        {children}
        {model && (asImage
          ? <img ref={atlasRef} className="rb-overview-atlas" aria-hidden="true" alt="" draggable={false}
            src={imageUrl ?? undefined} onLoad={imageLoaded} style={bounds} />
          : <canvas ref={atlasRef} className="rb-overview-atlas" aria-hidden="true" style={bounds} />)}
      </div>
    </OverviewRasterContext.Provider>
  );
}

export function BoardRasterLayer({ items, children, ...props }) {
  const runs = useMemo(() => overviewPaintRuns(items), [items]);
  const stickyCount = useMemo(() => items.filter(item => item.type === 'sticky').length, [items]);
  const elements = new Map();
  React.Children.forEach(children, child => { if (React.isValidElement(child)) elements.set(child.props.item.id, child); });
  return runs.map(run => {
    const visible = run.items.map(item => elements.get(item.id)).filter(Boolean);
    if (!visible.length) return null;
    return run.raster ? <RasterGroup key={run.key} items={run.items} pixelBudget={OVERVIEW_RASTER_MAX_PIXELS * run.items.length / stickyCount} {...props}>{visible}</RasterGroup> : <React.Fragment key={run.key}>{visible}</React.Fragment>;
  });
}
