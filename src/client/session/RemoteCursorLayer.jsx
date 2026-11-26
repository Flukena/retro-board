import React from 'react';
import { MousePointer2 } from 'lucide-react';
import { PRESENCE_LABEL_TRANSFORM } from '../board/presence-zoom.js';
import { hueFromId, playerAccentColor } from '../board/player-colors.js';
import { Z } from '../chrome/chrome-layout.js';

const CURSOR_ICON_PX = 23;
const CURSOR_STROKE_WIDTH = 2.6;
const CURSOR_TRANSITION_MS = 18;
const LABEL_MARGIN_LEFT_PX = -2;
const LABEL_MARGIN_TOP_PX = 17;
const LABEL_MAX_WIDTH_PX = 160;
const LABEL_FONT_SIZE_PX = 13;
const LABEL_LINE_HEIGHT = 1.15;
const LABEL_FONT_WEIGHT = 700;
const LABEL_PADDING_Y_PX = 4;
const LABEL_PADDING_X_PX = 8;

export function RemoteCursorLayer({ cursorLayerRef, playerCursors }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed', inset: 0, zIndex: Z.CURSOR_LAYER,
        overflow: 'hidden', pointerEvents: 'none',
      }}
    >
      <div
        ref={cursorLayerRef}
        className="rb-player-cursor-camera"
        style={{ position: 'absolute', inset: 0, transformOrigin: '0 0' }}
      >
        {playerCursors.map((player) => {
          const color = playerAccentColor(hueFromId(player.userId));
          return (
            <div
              key={player.userId}
              className="rb-player-cursor"
              data-cursor-x={player.cursor.x}
              data-cursor-y={player.cursor.y}
              style={{
                position: 'absolute', left: 0, top: 0,
                translate: `${player.cursor.x}px ${player.cursor.y}px`,
                transform: PRESENCE_LABEL_TRANSFORM,
                transformOrigin: '0 0',
                transition: `translate ${CURSOR_TRANSITION_MS}ms linear`,
                display: 'flex', alignItems: 'flex-start',
              }}
            >
              <MousePointer2
                size={CURSOR_ICON_PX}
                color="var(--collaboration-foreground)"
                fill={color}
                strokeWidth={CURSOR_STROKE_WIDTH}
                style={{ filter: 'var(--cursor-filter)', flex: '0 0 auto' }}
              />
              <span
                style={{
                  marginLeft: LABEL_MARGIN_LEFT_PX, marginTop: LABEL_MARGIN_TOP_PX,
                  maxWidth: LABEL_MAX_WIDTH_PX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  padding: `${LABEL_PADDING_Y_PX}px ${LABEL_PADDING_X_PX}px`, borderRadius: 'var(--radius-cursor-label)',
                  background: color, color: 'var(--collaboration-foreground)',
                  fontSize: LABEL_FONT_SIZE_PX, lineHeight: LABEL_LINE_HEIGHT, fontWeight: LABEL_FONT_WEIGHT,
                  boxShadow: 'var(--shadow-cursor-label)',
                }}
              >
                {player.name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
