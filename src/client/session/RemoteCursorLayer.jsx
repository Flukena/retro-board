import React from 'react';
import { MousePointer2 } from 'lucide-react';
import { cursorScreenPosition } from './player-cursors.js';
import { hueFromId, playerAccentColor } from '../board/player-colors.js';
import { Z } from '../chrome/chrome-layout.js';

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
                transition: 'transform 18ms linear',
                willChange: 'transform',
                display: 'flex', alignItems: 'flex-start',
              }}
            >
              <MousePointer2
                size={23}
                color="var(--collaboration-foreground)"
                fill={color}
                strokeWidth={2.6}
                style={{ filter: 'var(--cursor-filter)', flex: '0 0 auto' }}
              />
              <span
                style={{
                  marginLeft: -2, marginTop: 17,
                  maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  padding: '4px 8px', borderRadius: 'var(--radius-cursor-label)',
                  background: color, color: 'var(--collaboration-foreground)',
                  fontSize: 13, lineHeight: 1.15, fontWeight: 700,
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
