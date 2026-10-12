import React from 'react';
import { MODAL_SIZE, MODAL_LAYER, modalSizeClass, modalLayerClass, modalLayerZ } from './ui-variants.js';
import './ui.css';

function stopPanelClick(event) { event.stopPropagation(); }

export function ModalShell({
  labelledBy, onDismiss, size = MODAL_SIZE.SM, layer = MODAL_LAYER.DEFAULT, children, ...attributes
}) {
  return (
    <div
      {...attributes}
      aria-labelledby={labelledBy}
      className={modalLayerClass(layer)}
      style={{ zIndex: modalLayerZ(layer) }}
      onClick={onDismiss}
    >
      <div
        className={modalSizeClass(size)}
        onClick={onDismiss ? stopPanelClick : undefined}
      >
        {children}
      </div>
    </div>
  );
}
