import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Eye, EyeOff, ThumbsUp, Square, Ellipsis, X } from 'lucide-react';
import { t } from './i18n.js';
import { PALETTE } from './palette.js';
import { zoneCardVars } from './card-look.js';
import { ZONE_TITLE_MAX_LENGTH } from './security-boundaries.js';
import { zoneTitleFontSize } from './zone-title.js';
import { ZoneToolStrip, ZoneToolPopup } from './ZoneToolStrip.jsx';
import { TimerSetup } from './TimerSetup.jsx';
import { usePresence } from './usePresence.js';
import { createZoneMenuActions } from './zone-menu-actions.js';
import { useDismiss } from './useDismiss.js';
import './board-cards.css';

const SINGLE_CARD_COUNT = 1;

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

export function ZoneHeader({ item, isAdmin, revealed, hasVoteTimer, actions,
  menuOpen, onToggleMenu, onCloseMenu, canEdit, canDelete, timerSetupOpen, nestedZoneCount,
  presence = { mounted: !!menuOpen, state: 'open' } }) {
  const menuActions = createZoneMenuActions(actions, onCloseMenu);
  const toolsProps = { item, canEdit, canDelete, actions: menuActions, state: presence.state };
  return (
    <div className="rb-zone__actions" onMouseDown={stopHeaderEvent} onDoubleClick={stopHeaderEvent} onClick={stopHeaderEvent}>
      {presence.mounted && <ZoneToolStrip {...toolsProps} />}
      {presence.mounted && <ZoneToolPopup {...toolsProps} isAdmin={isAdmin} revealed={revealed} hasVoteTimer={hasVoteTimer} />}
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
  item, selected, isEditingTitle, childCount, lang, isAdmin, revealed, hasVoteTimer,
  actions, canEdit, canDelete, timerSetupOpen, nestedZoneCount,
  onStartZoneDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur,
  editAreaRef, TextEditor,
}) {
  void lang; // Language changes must invalidate React.memo for localized labels.
  const [menuOpen, setMenuOpen] = useState(false);
  const presence = usePresence(menuOpen);
  const headerRef = useRef(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuOpen, headerRef, closeMenu);
  useEffect(() => { if (timerSetupOpen) closeMenu(); }, [timerSetupOpen, closeMenu]);
  const it = item;
  const c = PALETTE[it.color] || PALETTE[0];
  const titleFs = zoneTitleFontSize(it);
  return (
    <div
      className={selected ? 'rb-zone rb-zone--selected' : 'rb-zone'}
      style={{
        left: it.x,
        top: it.y,
        width: it.w,
        height: it.h,
        '--rb-zone-width': `${it.w}px`,
        ...zoneCardVars(c),
      }}
    >
      <div ref={headerRef} className="rb-zone__title" style={{ fontSize: titleFs }}>
        <div className={isEditingTitle ? 'rb-zone__chip rb-zone__chip--editing' : 'rb-zone__chip'}
          onMouseDown={(e) => { if (!isEditingTitle) onStartZoneDrag(e, it); }}
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
        <ZoneHeader item={it} isAdmin={isAdmin} revealed={revealed} hasVoteTimer={hasVoteTimer}
          actions={actions} canEdit={canEdit} canDelete={canDelete} menuOpen={menuOpen}
          presence={presence} onCloseMenu={closeMenu}
          onToggleMenu={() => setMenuOpen((open) => !open)}
          timerSetupOpen={timerSetupOpen} nestedZoneCount={nestedZoneCount} />
      </div>
      <div data-surface="1" className="rb-zone__surface" />
    </div>
  );
});

