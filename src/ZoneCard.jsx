import React from 'react';
import { Lock } from 'lucide-react';
import { t } from './i18n.js';
import { PALETTE } from './palette.js';
import { zoneCardVars } from './card-look.js';
import { ZONE_TITLE_MAX_LENGTH } from './security-boundaries.js';
import './board-cards.css';

export const ZONE_TITLE_H = 40;
const ZONE_TITLE_FONT_SIZE_PX = 16;
const ZONE_TITLE_EXTRA_HEIGHT_PX = 18;
const SINGLE_CARD_COUNT = 1;

export const ZoneCard = React.memo(function ZoneCard({
  item, selected, isEditingTitle, childCount, lang,
  onStartZoneDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur,
  editAreaRef, TextEditor,
}) {
  void lang;
  const it = item;
  const c = PALETTE[it.color] || PALETTE[0];
  const titleFs = it.fontSize || ZONE_TITLE_FONT_SIZE_PX;
  const titleH = Math.max(ZONE_TITLE_H, titleFs + ZONE_TITLE_EXTRA_HEIGHT_PX);
  return (
    <div
      className={selected ? 'rb-zone rb-zone--selected' : 'rb-zone'}
      style={{
        left: it.x,
        top: it.y,
        width: it.w,
        height: it.h,
        ...zoneCardVars(c),
      }}
    >
      <div
        onMouseDown={(e) => { if (!isEditingTitle) onStartZoneDrag(e, it); }}
        onDoubleClick={(e) => { e.stopPropagation(); onBeginFocus(it, 'title'); }}
        className="rb-zone__title"
        style={{
          top: -titleH,
          height: titleH,
          cursor: isEditingTitle ? 'text' : (it.locked ? 'not-allowed' : 'grab'),
          fontSize: titleFs,
        }}
      >
        <div className={isEditingTitle ? 'rb-zone__chip rb-zone__chip--editing' : 'rb-zone__chip'}>
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
      </div>
      <div data-surface="1" className="rb-zone__surface" />
    </div>
  );
});

