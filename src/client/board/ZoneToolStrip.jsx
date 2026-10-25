import { BOARD_MODE } from '../../domain/public-wall-contract.js';
import React, { useState } from 'react';
import { createZoneToolScrollHandlers } from './mobile-gestures.js';
import { zoneTitleFontSize } from '../../domain/zone-title.js';
import { portalToBody } from '../ui/UiPrimitives.jsx';
import { ZONE_HEADER_SIZE_TOKENS } from '../ui/theme.js';
import { Lock, Unlock, Download, LayoutTemplate, ArrowUpToLine, ArrowDownToLine, Trash2, Eye, EyeOff, ThumbsUp, Square } from 'lucide-react';
import { ColorSwatches, FontSizeControl } from './SelectionToolbar.jsx';
import { t } from '../ui/i18n.js';
import { boardManagementPermissions } from '../../domain/public-board-permissions.js';
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
    toolButton('selection.bringToFront', ArrowUpToLine, !canEdit, () => actions.bringToFront(id), labelled),
    toolButton('selection.sendToBack', ArrowDownToLine, !canEdit, () => actions.sendToBack(id), labelled),
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
  const [scrollHandlers] = useState(createZoneToolScrollHandlers);
  return (
    <div className="rb-zone__tools rb-zone__tool-strip" data-state={state}
      data-mobile-gesture="native" data-board-shortcuts="off" {...scrollHandlers}
      inert={state === 'exit' ? '' : undefined}
      onMouseDown={stopEvent} onDoubleClick={stopEvent} onClick={stopEvent}>
      {[...styleTools(item, canEdit, actions), ...zoneTools(item, canEdit, canDelete, actions, false)]}
    </div>
  );
}

export function ZoneToolPopup({ item, canEdit, canDelete, actions, mode = BOARD_MODE.PRIVATE, isAdmin, revealed, hasVoteTimer, state, popupRef }) {
  const permissions = boardManagementPermissions(mode, isAdmin);
  const popup = (
    <div className="rb-zone__tools rb-zone__tool-popup" ref={popupRef}
      style={{ ...ZONE_HEADER_SIZE_TOKENS, '--rb-zone-tool-zoom': 1, '--rb-zone-title-size': `${zoneTitleFontSize(item)}px` }} role="group" aria-label={t('zone.options')} data-state={state}
      inert={state === 'exit' ? '' : undefined}
      onMouseDown={stopEvent} onDoubleClick={stopEvent} onClick={stopEvent}>
      {styleTools(item, canEdit, actions)}
      <div className="rb-zone__tool-divider" />
      <div className="rb-zone__popup-primary">
        {permissions.canManage && toolButton(revealed ? 'zone.hideCards' : 'zone.revealCards', revealed ? Eye : EyeOff,
          false, () => actions.toggleReveal(item.id), true)}
        {permissions.canManage && toolButton(hasVoteTimer ? 'topbar.stopVote' : 'zone.startVote', hasVoteTimer ? Square : ThumbsUp,
          false, () => actions.vote(item.id), true)}
      </div>
      {zoneTools(item, canEdit, canDelete, actions, true)}
    </div>
  );
  return portalToBody(popup);
}
