import React from 'react';
import { t } from '../ui/i18n.js';
import { TOOL_ID } from '../chrome/ToolDock.jsx';
import { Z } from '../chrome/chrome-layout.js';

export function ZonePreview({ zonePreview }) {
  return <>
          {zonePreview && (
            <div
              style={{
                position: 'absolute',
                left: zonePreview.x,
                top: zonePreview.y,
                width: zonePreview.w,
                height: zonePreview.h,
                background: 'var(--zone-preview-bg)',
                border: '2px dashed var(--zone-preview-border)',
                borderRadius: 'var(--radius-md)',
                pointerEvents: 'none',
              }}
            />
          )}
  </>;
}

export function EmptyCanvasHint({ itemCount, creationMode }) {
  return <>
        {itemCount === 0 && creationMode !== TOOL_ID.DRAW && (
          <div
            style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'var(--text-faint)', textAlign: 'center', pointerEvents: 'none',
              fontSize: 16,
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 8 }}>✨</div>
            <span className="rb-desktop-only">{t('empty.hint')}</span>
            <span className="rb-mobile-only">{t('mobile.emptyHint')}</span>
          </div>
        )}
  </>;
}

export function MarqueeSelection({ marquee }) {
  return <>
      {marquee && (
        <div
          style={{
            position: 'fixed',
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
            background: 'rgba(37,99,235,0.10)',
            border: '1.5px solid #2563eb',
            borderRadius: 'var(--radius-marquee)',
            pointerEvents: 'none',
            zIndex: Z.MARQUEE,
          }}
        />
      )}
  </>;
}
