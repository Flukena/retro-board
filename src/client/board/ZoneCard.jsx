import { BOARD_MODE } from '../../domain/public-wall-contract.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Eye, EyeOff, ThumbsUp, Square, Ellipsis, X } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { PALETTE } from '../ui/palette.js';
import { zoneCardVars } from './card-look.js';
import { ZONE_TITLE_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { zoneTitleFontSize } from '../../domain/zone-title.js';
import { ZONE_HEADER_SIZE_TOKENS } from '../ui/theme.js';
import { ZoneToolStrip, ZoneToolPopup } from './ZoneToolStrip.jsx';
import { TimerSetup } from '../voting/TimerSetup.jsx';
import { usePresence } from '../ui/usePresence.js';
import { createZoneMenuActions } from './zone-menu-actions.js';
import { useDismiss } from '../ui/useDismiss.js';
import { useZoneMenuViewport } from './zone-menu-viewport.js';
import './board-cards.css';
import { useTapToEdit } from './tap-to-edit.js';

const SINGLE_CARD_COUNT = 1;
const ZONE_EDGE_SIDES = ['top', 'bottom', 'left', 'right'];

const stopHeaderEvent = (event) => event.stopPropagation();
function headerButton(label, Icon, action, id) {
  return (
    <button type="button" className="rb-zone__icon" aria-label={t(label)}
      onMouseDown={stopHeaderEvent} onDoubleClick={stopHeaderEvent}
      onClick={(event) => { event.stopPropagation(); action(id); }}>
      <Icon aria-hidden="true" />
    </button>
  );
}

export function ZoneHeader({ mode = BOARD_MODE.PRIVATE, item, isAdmin, revealed, hasVoteTimer, actions,
  menuOpen, onToggleMenu, onCloseMenu, canEdit, canDelete, timerSetupOpen, nestedZoneCount,
  popupRef, presence = { mounted: !!menuOpen, state: 'open' } }) {
  const menuActions = createZoneMenuActions(actions, onCloseMenu);
  const toolsProps = { mode, item, canEdit, canDelete, actions: menuActions, state: presence.state };
  return (
    <div className="rb-zone__actions" onMouseDown={stopHeaderEvent} onDoubleClick={stopHeaderEvent} onClick={stopHeaderEvent}>
      {presence.mounted && <ZoneToolStrip {...toolsProps} />}
      {presence.mounted && <ZoneToolPopup {...toolsProps} popupRef={popupRef} isAdmin={isAdmin} revealed={revealed} hasVoteTimer={hasVoteTimer} />}
      {isAdmin && <div className="rb-zone__admin-action">
        {headerButton(revealed ? 'zone.hideCards' : 'zone.revealCards', revealed ? Eye : EyeOff, menuActions.toggleReveal, item.id)}
      </div>}
      {isAdmin && <div className="rb-zone__admin-action">
        {headerButton(hasVoteTimer ? 'topbar.stopVote' : 'zone.startVote', hasVoteTimer ? Square : ThumbsUp, menuActions.vote, item.id)}
      </div>}
      {isAdmin && timerSetupOpen && <div className="rb-zone__popover-anchor">
        <TimerSetup onClose={actions.closeTimerSetup}
          onStart={(...args) => actions.startTimer(item.id, ...args)} nestedZoneCount={nestedZoneCount} />
      </div>}
      <button type="button" className="rb-zone__icon rb-zone__menu" aria-label={t(menuOpen ? 'zone.closeOptions' : 'zone.options')}
        aria-expanded={!!menuOpen} onMouseDown={stopHeaderEvent} onDoubleClick={stopHeaderEvent}
        onClick={(event) => { event.stopPropagation(); onToggleMenu(); }}>
        <Ellipsis className="rb-zone__menu-dots" aria-hidden="true" />
        <X className="rb-zone__menu-close" aria-hidden="true" />
      </button>
    </div>
  );
}

export const ZoneCard = React.memo(function ZoneCard({
  mode = BOARD_MODE.PRIVATE, zoom = 1, item, selected, isEditingTitle, childCount, lang, isAdmin, revealed, hasVoteTimer,
  actions, canEdit, canDelete, timerSetupOpen, nestedZoneCount,
  onStartZoneDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur,
  editAreaRef, TextEditor,
}) {
  void lang; // Language changes must invalidate React.memo for localized labels.
  const [menuOpen, setMenuOpen] = useState(false);
  const watchTapToEdit = useTapToEdit({ selected, enabled: !isEditingTitle });
  const presence = usePresence(menuOpen);
  const headerRef = useRef(null);
  const popupRef = useRef(null);
  useZoneMenuViewport(headerRef, popupRef, presence.mounted, presence.state, zoom);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuOpen, headerRef, closeMenu, popupRef);
  useEffect(() => { if (timerSetupOpen) closeMenu(); }, [timerSetupOpen, closeMenu]);
  const it = item;
  const c = PALETTE[it.color] || PALETTE[0];
  const titleFs = zoneTitleFontSize(it);
  return (
    <div
      className={selected ? 'rb-zone rb-zone--selected' : 'rb-zone'}
      data-zoomed-out={zoom < 1}
      style={{
        left: it.x,
        top: it.y,
        width: it.w,
        height: it.h,
        '--rb-zone-width': `${it.w}px`,
        '--rb-zone-canvas-zoom': zoom,
        ...zoneCardVars(c),
      }}
    >
      <div ref={headerRef} className="rb-zone__title" style={{ ...ZONE_HEADER_SIZE_TOKENS, fontSize: titleFs, '--rb-zone-title-size': `${titleFs}px` }}>
        <div className={isEditingTitle ? 'rb-zone__chip rb-zone__chip--editing' : 'rb-zone__chip'}
          onMouseDown={(e) => {
            if (isEditingTitle) return;
            watchTapToEdit(e, () => onBeginFocus(it, 'title'));
            onStartZoneDrag(e, it);
          }}
          onDoubleClick={(e) => { e.stopPropagation(); onBeginFocus(it, 'title'); }}
          style={{ cursor: isEditingTitle ? 'text' : (it.locked ? 'not-allowed' : 'grab') }}>
          {isEditingTitle ? (
            <TextEditor
              kind="input"
              editorRef={editAreaRef}
              value={it.title || ''}
              maxLength={ZONE_TITLE_MAX_LENGTH}
              onValueChange={(value) => onTextChange(it.id, { title: value })}
              onKeyDown={(e) => onTextKeyDown(e, { singleLine: true })}
              onBlur={() => onTextBlur(it.id)}
              onMouseDown={(e) => e.stopPropagation()}
              className="rb-zone__editor"
              style={{
                fontSize: titleFs,
              }}
            />
          ) : (
            <>
              {it.locked && <Lock className="rb-zone__lock" />}
              <span className="rb-zone__label">
                {it.title}
              </span>
              <span className="rb-zone__count">
                {t(childCount === SINGLE_CARD_COUNT ? 'zone.cardCountOne' : 'zone.cardCount', { n: childCount })}
              </span>
            </>
          )}
        </div>
        <ZoneHeader mode={mode} item={it} isAdmin={isAdmin} revealed={revealed} hasVoteTimer={hasVoteTimer}
          actions={actions} canEdit={canEdit} canDelete={canDelete} menuOpen={menuOpen}
          presence={presence} popupRef={popupRef} onCloseMenu={closeMenu}
          onToggleMenu={() => setMenuOpen((open) => !open)}
          timerSetupOpen={timerSetupOpen} nestedZoneCount={nestedZoneCount} />
      </div>
      <div data-surface="1" className="rb-zone__surface" />
      {ZONE_EDGE_SIDES.map((side) => (
        <div key={side} className="rb-zone__edge" data-edge={side} data-locked={!!it.locked}
          onMouseDown={(event) => onStartZoneDrag(event, it)}
          onDoubleClick={stopHeaderEvent} />
      ))}
    </div>
  );
});

