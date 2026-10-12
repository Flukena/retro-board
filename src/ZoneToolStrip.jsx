import React from 'react';
import { Lock, Unlock, Download, LayoutTemplate, BringToFront, SendToBack, Trash2, Eye, EyeOff, ThumbsUp, Square } from 'lucide-react';
import { ColorSwatches, FontSizeControl } from './SelectionToolbar.jsx';
import { t } from './i18n.js';
import './board-cards.css';

const stopEvent = (event) => event.stopPropagation();
function toolButton(key, Icon, disabled, action, labelled = false) {
  return (
    <button type="button" key={key} className="rb-zone__icon" aria-label={t(key)} title={t(key)}
      disabled={disabled} onClick={() => { if (!disabled) action(); }}>
      <Icon aria-hidden="true" />
      {labelled && <span>{t(key)}</span>}
    </button>
  );
}

function zoneTools(item, canEdit, canDelete, actions, labelled) {
  const id = item.id;
  return [
    toolButton(item.locked ? 'zone.lockToggle.off' : 'zone.lockToggle.on', item.locked ? Lock : Unlock,
      !canEdit, () => actions.toggleLock(id), labelled),
    toolButton('zone.exportCsvTitle', Download, false, () => actions.exportCsv(id), labelled),
    toolButton('selection.saveTemplate', LayoutTemplate, false, () => actions.saveTemplate(id), labelled),
    toolButton('selection.bringToFront', BringToFront, !canEdit, () => actions.bringToFront(id), labelled),
    toolButton('selection.sendToBack', SendToBack, !canEdit, () => actions.sendToBack(id), labelled),
    toolButton('common.delete', Trash2, !canDelete, () => actions.remove(id), labelled),
  ];
}

function styleTools(item, canEdit, actions) {
  return [
    <ColorSwatches key="color" colorIndex={item.color} can={canEdit} onColor={(color) => actions.color(item.id, color)} />,
    <FontSizeControl key="fontSize" item={item} can={canEdit} onFontSize={(size) => actions.fontSize(item.id, size)} />,
  ];
}

export function ZoneToolStrip({ item, canEdit, canDelete, actions, state = 'open' }) {
  return (
    <div className="rb-zone__tools rb-zone__tool-strip" data-state={state}
      inert={state === 'exit' ? '' : undefined}
      onMouseDown={stopEvent} onDoubleClick={stopEvent} onClick={stopEvent}>
      {[...styleTools(item, canEdit, actions), ...zoneTools(item, canEdit, canDelete, actions, false)]}
    </div>
  );
}

export function ZoneToolPopup({ item, canEdit, canDelete, actions, isAdmin, revealed, hasVoteTimer, state }) {
  return (
    <div className="rb-zone__tools rb-zone__tool-popup" role="group" aria-label={t('zone.options')} data-state={state}
      inert={state === 'exit' ? '' : undefined}
      onMouseDown={stopEvent} onDoubleClick={stopEvent} onClick={stopEvent}>
      {styleTools(item, canEdit, actions)}
      <div className="rb-zone__tool-divider" />
      {isAdmin && toolButton(revealed ? 'zone.hideCards' : 'zone.revealCards', revealed ? Eye : EyeOff,
        false, () => actions.toggleReveal(item.id), true)}
      {isAdmin && toolButton(hasVoteTimer ? 'topbar.stopVote' : 'zone.startVote', hasVoteTimer ? Square : ThumbsUp,
        false, () => actions.vote(item.id), true)}
      {zoneTools(item, canEdit, canDelete, actions, true)}
    </div>
  );
}
