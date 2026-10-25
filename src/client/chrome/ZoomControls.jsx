import React from 'react';
import { ZoomOut, ZoomIn, Maximize2 } from 'lucide-react';
import { Button } from '../ui/UiPrimitives.jsx';
import {
  DOCK_INSET_PX, ZOOM_BUTTON_H_PX, ZOOM_PADDING_PX, CHROME_BORDER_PX,
  CHROME_ICON_SIZE_PX, Z,
} from './chrome-layout.js';
import { t } from '../ui/i18n.js';
import './zoom-controls.css';

export function ZoomControls({ percentage, onZoomOut, onResetZoom, onZoomIn, onFitToContent }) {
  return (
    <div
      className="rb-zoom-controls"
      style={{
        '--rb-zoom-inset-px': `${DOCK_INSET_PX}px`, zIndex: Z.DOCK,
        '--rb-zoom-button-height': `${ZOOM_BUTTON_H_PX}px`,
        '--rb-zoom-padding': `${ZOOM_PADDING_PX}px`,
        '--rb-chrome-border': `${CHROME_BORDER_PX}px`,
      }}
    >
      <Button className="rb-btn--icon-sm" title={t('zoom.out')} onClick={onZoomOut}>
        <ZoomOut size={CHROME_ICON_SIZE_PX.TOOL} />
      </Button>
      <Button className="rb-zoom-percentage rb-btn--mono" title={t('zoom.reset')} onClick={onResetZoom}>
        {percentage}%
      </Button>
      <Button className="rb-btn--icon-sm" title={t('zoom.in')} onClick={onZoomIn}>
        <ZoomIn size={CHROME_ICON_SIZE_PX.TOOL} />
      </Button>
      <Button className="rb-btn--icon-sm" title={t('zoom.fit')} onClick={onFitToContent}>
        <Maximize2 size={CHROME_ICON_SIZE_PX.TOOL} />
      </Button>
    </div>
  );
}
