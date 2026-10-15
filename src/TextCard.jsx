import React from 'react';
import { BOARD_TEXT_MAX_LENGTH } from './security-boundaries.js';
import { sizeForPlacement } from './board-geometry.js';
import { fontSizeForItem } from './selection-toolbar-model.js';
import { CollaborativeTextEditor } from './CollaborativeTextEditor.jsx';

const { w: TEXT_WIDTH_PX, h: TEXT_HEIGHT_PX } = sizeForPlacement({ type: 'text' });
const TEXT_FONT_SIZE_PX = fontSizeForItem({ type: 'text' });

export const TextCard = React.memo(function TextCard({
  item, selected, remoteSelected, remoteSelectionHue, isEditing, lang,
  onStartDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur,
  editAreaRef,
}) {
  void lang;
  const it = item;
  return (
    <div
      className={remoteSelected ? 'rb-remote-selected-card' : undefined}
      onMouseDown={(e) => { if (!isEditing) onStartDrag(e, it); }}
      onDoubleClick={(e) => { e.stopPropagation(); onBeginFocus(it, 'text'); }}
      style={{
        position: 'absolute',
        ['--rb-selector-hue']: remoteSelectionHue,
        left: it.x,
        top: it.y,
        fontFamily: 'var(--font-handwriting)',
        fontSize: it.fontSize || TEXT_FONT_SIZE_PX,
        color: it.fontColor || 'var(--text)',
        cursor: isEditing ? 'text' : 'grab',
        userSelect: 'none',
        padding: '4px 8px',
        width: it.w || TEXT_WIDTH_PX,
        height: it.h || TEXT_HEIGHT_PX,
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        outline: selected ? '2px dashed #2563eb' : 'none',
        outlineOffset: 6,
        borderRadius: 'var(--radius-text-card)',
        animation: remoteSelected ? undefined : 'rb-appear 0.28s ease-out',
      }}
    >
      {isEditing ? (
        <CollaborativeTextEditor
          editorRef={editAreaRef}
          value={it.text || ''}
          maxLength={BOARD_TEXT_MAX_LENGTH}
          onValueChange={(value) => onTextChange(it.id, { text: value })}
          onKeyDown={(e) => onTextKeyDown(e)}
          onBlur={() => onTextBlur(it.id)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: '100%', height: '100%',
            background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', fontFamily: 'inherit', fontSize: it.fontSize || TEXT_FONT_SIZE_PX,
            color: it.fontColor || 'var(--text)',
          }}
        />
      ) : it.text}
    </div>
  );
});

