import React from 'react';
import { MousePointer2 } from 'lucide-react';
import { cursorScreenPosition } from './player-cursors.js';
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

export function RemoteCursorLayer({ cursorLayerRef, viewportRef, playerCursors }) {
  return (
    <div
      ref={cursorLayerRef}
      aria-hidden="true"
      style={{
        position: 'fixed', inset: 0, zIndex: Z.CURSOR_LAYER,
        overflow: 'hidden', pointerEvents: 'none',
      }}
    >
      {playerCursors.map((player) => {
        const screen = cursorScreenPosition(player.cursor, viewportRef.current);
        const color = playerAccentColor(hueFromId(player.userId));
        return (
          <div
            key={player.userId}
            className="rb-player-cursor"
            data-cursor-x={player.cursor.x}
            data-cursor-y={player.cursor.y}
            style={{
              position: 'absolute', left: 0, top: 0,
              transform: `translate3d(${screen.x}px, ${screen.y}px, 0)`,
              transition: `transform ${CURSOR_TRANSITION_MS}ms linear`,
              willChange: 'transform',
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
  );
}
