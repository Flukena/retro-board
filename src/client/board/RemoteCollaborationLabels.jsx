import React from 'react';
import { MousePointer2 } from 'lucide-react';
import { hueFromId, playerAccentColor } from './player-colors.js';
import { selectionLabelMessage } from './selection-labels.js';
import { sizeForResize } from '../../domain/board-geometry.js';
import { remoteEditingFrameStyle } from './editing-presence-look.js';
import { Z } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';

const MIN_LABEL_ZOOM = 0.01;

export function RemoteCollaborationLabels({ selectionLabels, editingIndicators, viewport }) {
  return <>
          {/* Remote card selection label. The glow itself is applied directly
              to each selected card instead of drawing a second card-sized
              layer over it. */}
          {selectionLabels.map((group) => {
            const zoom = Math.max(viewport.zoom, MIN_LABEL_ZOOM);
            const color = playerAccentColor(hueFromId(group.selector.userId));
            const label = t(...selectionLabelMessage(group));
            return (
              <React.Fragment key={`selection:${group.key}`}>
                <div
                  role="status"
                  aria-label={label}
                  style={{
                    position: 'absolute', left: group.x,
                    top: group.y - (34 / zoom),
                    transform: `scale(${1 / zoom})`, transformOrigin: 'top left',
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    maxWidth: 240, padding: '5px 9px 5px 7px',
                    borderRadius: 'var(--radius-pill)', background: color, color: 'var(--collaboration-foreground)',
                    boxShadow: 'var(--shadow-remote-selection-label)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 13, lineHeight: 1.2, fontWeight: 700,
                    whiteSpace: 'nowrap', pointerEvents: 'none',
                    zIndex: Z.REMOTE_SELECTION_LABEL,
                  }}
                >
                  <MousePointer2 size={13} style={{ flex: '0 0 auto' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                </div>
              </React.Fragment>
            );
          })}

          {/* Collaboration editing presence. Kept outside each card so the
              badge is never clipped by card paint-containment, and counter-
              scaled so names stay readable at every board zoom level. */}
          {editingIndicators.map(({ item, editor }) => {
            const zoom = Math.max(viewport.zoom, MIN_LABEL_ZOOM);
            const height = sizeForResize(item).h;
            const editorHue = hueFromId(editor.userId);
            const color = playerAccentColor(editorHue);
            const glow = playerAccentColor(editorHue, 0.18);
            const label = editor.extraCount > 0
              ? t('editing.byMany', { name: editor.name, n: editor.extraCount })
              : t('editing.by', { name: editor.name });
            return (
              <React.Fragment key={`editing:${item.id}`}>
                <div
                  aria-hidden="true"
                  style={remoteEditingFrameStyle(item, { zoom, color, glow })}
                />
                <div
                  role="status"
                  aria-label={label}
                  style={{
                    position: 'absolute', left: item.x,
                    top: item.y + height + (8 / zoom),
                    transform: `scale(${1 / zoom})`, transformOrigin: 'top left',
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    maxWidth: 240, padding: '5px 9px 5px 7px',
                    borderRadius: 'var(--radius-pill)', background: color, color: 'var(--collaboration-foreground)',
                    boxShadow: 'var(--shadow-remote-editor-label)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 13, lineHeight: 1.2, fontWeight: 700,
                    whiteSpace: 'nowrap', pointerEvents: 'none',
                    zIndex: Z.REMOTE_EDITOR_LABEL,
                  }}
                >
                  <span
                    className="rb-editing-dot"
                    style={{
                      width: 7, height: 7, borderRadius: 'var(--radius-round)',
                      background: 'var(--collaboration-foreground)', flex: '0 0 auto',
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                </div>
              </React.Fragment>
            );
          })}

  </>;
}
