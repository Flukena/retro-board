import React from 'react';
import { Lock, Unlock, Download, LayoutTemplate, BringToFront, SendToBack, Trash2 } from 'lucide-react';
import { ColorSwatches, FontSizeControl } from './SelectionToolbar.jsx';
import { t } from './i18n.js';
import './board-cards.css';

const stopEvent = (event) => event.stopPropagation();
function toolButton(key, Icon, disabled, action) {
  return (
    <button type="button" className="rb-zone__icon" aria-label={t(key)} title={t(key)}
      disabled={disabled} onClick={() => { if (!disabled) action(); }}>
      <Icon aria-hidden="true" />
    </button>
  );
}

export function ZoneToolStrip({ item, canEdit, canDelete, actions }) {
  const id = item.id;
  return (
    <div className="rb-zone__tool-strip" onMouseDown={stopEvent} onDoubleClick={stopEvent} onClick={stopEvent}>
      <ColorSwatches colorIndex={item.color} can={canEdit} onColor={(color) => actions.color(id, color)} />
      <FontSizeControl item={item} can={canEdit} onFontSize={(size) => actions.fontSize(id, size)} />
      {toolButton(item.locked ? 'zone.lockToggle.off' : 'zone.lockToggle.on', item.locked ? Lock : Unlock,
        !canEdit, () => actions.toggleLock(id))}
      {toolButton('zone.exportCsvTitle', Download, false, () => actions.exportCsv(id))}
      {toolButton('selection.saveTemplate', LayoutTemplate, false, () => actions.saveTemplate(id))}
      {toolButton('selection.bringToFront', BringToFront, !canEdit, () => actions.bringToFront(id))}
      {toolButton('selection.sendToBack', SendToBack, !canEdit, () => actions.sendToBack(id))}
      {toolButton('common.delete', Trash2, !canDelete, () => actions.remove(id))}
    </div>
  );
}
