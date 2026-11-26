import React from 'react';
import { MousePointer2 } from 'lucide-react';
import { hueFromId, playerAccentColor } from './player-colors.js';
import { selectionLabelMessage } from './selection-labels.js';
import { sizeForResize } from '../../domain/board-geometry.js';
import { remoteEditingFrameStyle } from './editing-presence-look.js';
import { PRESENCE_LABEL_TRANSFORM } from './presence-zoom.js';
import { Z } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';

const SELECTION_OFFSET_PX = -34;
const EDITING_OFFSET_PX = 8;
const SELECTION_ICON_PX = 13;
const EDITING_DOT_PX = 7;
const EDITING_GLOW_ALPHA = 0.18;
const LABEL_GAP_PX = 7;
const LABEL_MAX_WIDTH_PX = 240;
const LABEL_FONT_SIZE_PX = 13;

const labelStyle = {
  position: 'absolute', transformOrigin: 'top left',
  display: 'inline-flex', alignItems: 'center', gap: LABEL_GAP_PX,
  maxWidth: LABEL_MAX_WIDTH_PX, padding: '5px 9px 5px 7px',
  borderRadius: 'var(--radius-pill)', color: 'var(--collaboration-foreground)',
  fontFamily: 'var(--font-ui)', fontSize: LABEL_FONT_SIZE_PX, lineHeight: 1.2, fontWeight: 700,
  whiteSpace: 'nowrap', pointerEvents: 'none',
};

function CollaborationLabel({ x, y, offsetPx, label, background, boxShadow, zIndex, children }) {
  return (
    <div
      role="status"
      aria-label={label}
      style={{
        left: x, top: y,
        transform: `${PRESENCE_LABEL_TRANSFORM} translateY(${offsetPx}px)`,
        ...labelStyle, background, boxShadow, zIndex,
      }}
    >
      {children}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </div>
  );
}

export function RemoteCollaborationLabels({ selectionLabels, editingIndicators, labelLayerRef }) {
  return (
    <div ref={labelLayerRef} style={{ display: 'contents' }}>
      {selectionLabels.map((group) => (
        <CollaborationLabel
          key={`selection:${group.key}`}
          x={group.x}
          y={group.y}
          offsetPx={SELECTION_OFFSET_PX}
          label={t(...selectionLabelMessage(group))}
          background={playerAccentColor(hueFromId(group.selector.userId))}
          boxShadow="var(--shadow-remote-selection-label)"
          zIndex={Z.REMOTE_SELECTION_LABEL}
        >
          <MousePointer2 size={SELECTION_ICON_PX} style={{ flex: '0 0 auto' }} />
        </CollaborationLabel>
      ))}
      {editingIndicators.map(({ item, editor }) => {
        const height = sizeForResize(item).h;
        const editorHue = hueFromId(editor.userId);
        const color = playerAccentColor(editorHue);
        const glow = playerAccentColor(editorHue, EDITING_GLOW_ALPHA);
        const label = editor.extraCount > 0
          ? t('editing.byMany', { name: editor.name, n: editor.extraCount })
          : t('editing.by', { name: editor.name });
        return (
          <React.Fragment key={`editing:${item.id}`}>
            <div aria-hidden="true" style={remoteEditingFrameStyle(item, { color, glow })} />
            <CollaborationLabel
              x={item.x}
              y={item.y + height}
              offsetPx={EDITING_OFFSET_PX}
              label={label}
              background={color}
              boxShadow="var(--shadow-remote-editor-label)"
              zIndex={Z.REMOTE_EDITOR_LABEL}
            >
              <span
                className="rb-editing-dot"
                style={{
                  width: EDITING_DOT_PX, height: EDITING_DOT_PX, borderRadius: 'var(--radius-round)',
                  background: 'var(--collaboration-foreground)', flex: '0 0 auto',
                }}
              />
            </CollaborationLabel>
          </React.Fragment>
        );
      })}
    </div>
  );
}
