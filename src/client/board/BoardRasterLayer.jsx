import React, { useMemo, useRef, useState } from 'react';
import { OverviewRasterContext } from './overview-raster-context.js';
import { overviewRasterModel, overviewPaintRuns, OVERVIEW_RASTER_MAX_PIXELS, OVERVIEW_RASTER_MAX_DPR } from './overview-raster-model.js';
import { OverviewRasterPainter, overviewFontLoadAffectsPaint } from './overview-raster-paint.js';
import { t } from '../ui/i18n.js';
import { useBrowserLayoutEffect as useLayoutEffect } from '../ui/use-browser-layout-effect.js';

function RasterGroup({ items, compact, dense, selectedIds, remoteSelectors, focusedTextId, detailedIds,
  contexts, allRevealed, userId, winners, lang, pixelBudget, children }) {
  const canvasRef = useRef(null), painterRef = useRef(null);
  const [paintedModel, setPaintedModel] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const enabled = dense && (compact || detailedIds != null) && !selectedIds.size && !remoteSelectors.size && !focusedTextId;
  const model = useMemo(() => enabled ? overviewRasterModel(items, { contexts, allRevealed, userId, winners,
    hiddenText: t('sticky.hidden'), maxPixels: pixelBudget, dpr: Math.min(globalThis.devicePixelRatio || 1, OVERVIEW_RASTER_MAX_DPR) }) : null,
  [items, enabled, contexts, allRevealed, userId, winners, lang, pixelBudget]);
  useLayoutEffect(() => {
    if (!model || !canvasRef.current) { painterRef.current = null; setPaintedModel(null); return undefined; }
    const canvas = canvasRef.current;
    const painter = new OverviewRasterPainter(canvas, model); painterRef.current = painter;
    let paintedFontFamily = '';
    const paint = () => {
      const style = getComputedStyle(canvas);
      paintedFontFamily = style.fontFamily;
      const ready = painter.draw({ fontFamily: style.fontFamily,
        padding: Number.parseFloat(style.getPropertyValue('--sticky-padding')),
        lineHeight: Number.parseFloat(style.getPropertyValue('--sticky-line-height')) });
      setPaintedModel(ready ? model : null);
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const paintFonts = event => { if (overviewFontLoadAffectsPaint(event, paintedFontFamily)) paint(); };
    document.fonts?.addEventListener('loadingdone', paintFonts);
    return () => { observer.disconnect(); document.fonts?.removeEventListener('loadingdone', paintFonts); painterRef.current = null; canvas.width = 0; canvas.height = 0; };
  }, [model]);
  useLayoutEffect(() => {
    painterRef.current?.setHidden(detailedIds);
    painterRef.current?.hover(hoveredId);
  }, [hoveredId, detailedIds, model]);
  return (
    <OverviewRasterContext.Provider value={model && model === paintedModel ? model.ids : null}>
      <div className="rb-overview-layer" onMouseOver={event => setHoveredId(event.target.closest?.('[data-sticky-id]')?.dataset.stickyId || null)}
        onMouseLeave={() => setHoveredId(null)}>
        {children}
        {model && <canvas ref={canvasRef} className="rb-overview-atlas" aria-hidden="true"
          style={{ left: model.bounds.x, top: model.bounds.y, width: model.bounds.w, height: model.bounds.h }} />}
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
