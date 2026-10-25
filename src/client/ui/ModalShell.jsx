import React, { useRef } from 'react';
import { X } from 'lucide-react';
import { MODAL_SIZE, MODAL_LAYER, modalSizeClass, modalLayerClass, modalLayerZ } from './ui-variants.js';
import { IconButton } from './UiPrimitives.jsx';
import { useBrowserLayoutEffect } from './use-browser-layout-effect.js';
import { subscribeModalInteraction } from './modal-interaction.js';
import { t } from './i18n.js';
import './ui.css';

function stopPanelClick(event) { event.stopPropagation(); }

export function ModalShell({
  labelledBy, onDismiss, className, dismissDisabled = false, closeAutoFocus = false,
  size = MODAL_SIZE.SM, layer = MODAL_LAYER.DEFAULT, children, ...attributes
}) {
  const overlay = useRef(null);
  const opener = useRef(globalThis.document?.activeElement);
  const dismissal = useRef(null);
  dismissal.current = dismissDisabled ? undefined : onDismiss;
  useBrowserLayoutEffect(() => subscribeModalInteraction(overlay.current, {
    dismiss: () => dismissal.current?.(), opener: opener.current,
  }), []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      {...attributes}
      ref={overlay}
      aria-labelledby={labelledBy}
      className={[modalLayerClass(layer), className].filter(Boolean).join(' ')}
      style={{ zIndex: modalLayerZ(layer) }}
      onClick={dismissDisabled ? undefined : onDismiss}
    >
      <div className={modalSizeClass(size)} tabIndex={-1} onClick={stopPanelClick}>
        <div className="rb-modal__content">{children}</div>
        {onDismiss && <IconButton
          className="rb-modal__close"
          aria-label={t('common.close')}
          disabled={dismissDisabled}
          autoFocus={closeAutoFocus}
          onClick={onDismiss}
        ><X size={18} /></IconButton>}
      </div>
    </div>
  );
}
