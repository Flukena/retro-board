import React from 'react';
import { MinimapCanvas } from './MinimapCanvas.jsx';
import {
  MINIMAP_W_PX, MINIMAP_H_PX, MINIMAP_PANEL_PADDING_TOTAL_PX,
  MINIMAP_BOTTOM_PX, DOCK_INSET_PX, CHROME_BORDER_PX, Z,
} from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';
import '../../domain/minimap.css';

export function MinimapPanel({
  panelRef, viewportRef, model, colors,
  onReveal, onNavigatePointerDown, onNavigateKeyDown,
}) {
  return (
    <aside
      ref={panelRef}
      className="rb-minimap"
      aria-label={t('minimap.title')}
      onPointerEnter={onReveal}
      onPointerLeave={onReveal}
      onFocusCapture={onReveal}
      onBlurCapture={onReveal}
      style={{
        '--rb-minimap-inset-px': `${DOCK_INSET_PX}px`,
        '--rb-minimap-bottom-px': `${MINIMAP_BOTTOM_PX}px`, zIndex: Z.DOCK,
        width: MINIMAP_W_PX + MINIMAP_PANEL_PADDING_TOTAL_PX,
        '--rb-minimap-padding': `${MINIMAP_PANEL_PADDING_TOTAL_PX / 2}px`,
        '--rb-minimap-width': `${MINIMAP_W_PX}px`,
        '--rb-minimap-height': `${MINIMAP_H_PX}px`,
        '--rb-minimap-border': `${CHROME_BORDER_PX}px`,
      }}
    >
      <div
        className="rb-minimap-surface rb-minimap__surface"
        role="button"
        tabIndex={0}
        aria-label={t('minimap.navigate')}
        title={t('minimap.navigate')}
        onPointerDown={onNavigatePointerDown}
        onKeyDown={onNavigateKeyDown}
      >
        <MinimapCanvas model={model} colors={colors} />
        <div
          ref={viewportRef}
          className="rb-minimap__viewport"
          aria-hidden="true"
          style={{
            width: model.viewport.w,
            height: model.viewport.h,
            transform: `translate3d(${model.viewport.x}px, ${model.viewport.y}px, 0)`,
          }}
        />
      </div>
    </aside>
  );
}
