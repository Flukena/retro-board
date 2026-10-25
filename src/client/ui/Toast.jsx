import React from 'react';
import { X } from 'lucide-react';
import { IconButton, Surface } from './UiPrimitives.jsx';
import { toastSurfaceKind } from './ui-variants.js';
import { TOAST_BOTTOM_PX, Z } from '../chrome/chrome-layout.js';
import { t } from './i18n.js';
import './toast.css';

const CLOSE_ICON_SIZE_PX = 14;

export function Toast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <Surface
      key={toast.t || toast.msg}
      kind={toastSurfaceKind(toast.type)}
      className="rb-toast"
      role="status"
      aria-live="polite"
      style={{ bottom: TOAST_BOTTOM_PX, zIndex: Z.TOAST }}
    >
      <span>{toast.msg}</span>
      {toast.sticky && (
        <IconButton className="rb-icon-btn--inherit" onClick={onClose} aria-label={t('common.close')}>
          <X size={CLOSE_ICON_SIZE_PX} />
        </IconButton>
      )}
    </Surface>
  );
}
