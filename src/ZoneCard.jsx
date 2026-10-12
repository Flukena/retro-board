import React from 'react';
import { Lock, Eye, EyeOff, ThumbsUp, Square, Ellipsis } from 'lucide-react';
import { t } from './i18n.js';
import { PALETTE } from './palette.js';
import { zoneCardVars } from './card-look.js';
import { ZONE_TITLE_MAX_LENGTH } from './security-boundaries.js';
import { zoneTitleFontSize } from './zone-title.js';
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

function headerActions(isAdmin, revealed, hasVoteTimer, onToggleReveal, onVote, onOptions, id) {
  return (
    <div className="rb-zone__actions">
      {isAdmin && headerButton(revealed ? 'zone.hideCards' : 'zone.revealCards', revealed ? Eye : EyeOff, onToggleReveal, id)}
      {isAdmin && headerButton(hasVoteTimer ? 'topbar.stopVote' : 'zone.startVote', hasVoteTimer ? Square : ThumbsUp, onVote, id)}
      {headerButton('zone.options', Ellipsis, onOptions, id)}
    </div>
  );
}

export const ZoneCard = React.memo(function ZoneCard({
  item, selected, isEditingTitle, childCount, lang, isAdmin, revealed, hasVoteTimer,
  onToggleReveal, onVote, onOptions,
  onStartZoneDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur,
  editAreaRef, TextEditor,
}) {
  void lang;
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
      <div className="rb-zone__title" style={{ fontSize: titleFs }}>
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
        {headerActions(isAdmin, revealed, hasVoteTimer, onToggleReveal, onVote, onOptions, it.id)}
      </div>
      <div data-surface="1" className="rb-zone__surface" />
    </div>
  );
});

