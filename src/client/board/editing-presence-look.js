import { sizeForPlacement } from '../../domain/board-geometry.js';
import { Z } from '../chrome/chrome-layout.js';

const EDITOR_BORDER_SCREEN_PX = 2;
const EDITOR_GLOW_SCREEN_PX = 3;
const CARD_RADIUS = Object.freeze({
  sticky: 'var(--radius-sticky)', text: 'var(--radius-text-card)',
  zone: 'var(--radius-zone)', image: 'var(--radius-image-card)',
});

export function remoteEditingFrameStyle(item, { zoom, color, glow }) {
  const { w: width, h: height } = sizeForPlacement(item);
  return {
    position: 'absolute', left: item.x, top: item.y,
    width, height, boxSizing: 'border-box',
    border: `${EDITOR_BORDER_SCREEN_PX / zoom}px solid ${color}`,
    // Card geometry scales with the world; only stroke and glow counter-scale.
    borderRadius: CARD_RADIUS[item.type] || CARD_RADIUS.image,
    boxShadow: `0 0 0 ${EDITOR_GLOW_SCREEN_PX / zoom}px ${glow}`,
    pointerEvents: 'none', zIndex: Z.REMOTE_EDITOR_BOX,
  };
}
