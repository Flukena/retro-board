import { webkitCompositing } from './webkit-compositing.js';

// WebKit composites the whole zoomed world while any transform or opacity
// animation runs inside it (the world has a transform, so it must become a
// layer to hold an animated descendant). On a dense board that layer covers
// the whole board and pushed iOS Safari past its tab memory limit when vote
// counts bumped in on zoom. Such boards keep the world still on WebKit.
export const WORLD_MOTION_ATTRIBUTE = 'data-world-motion';
export const WORLD_MOTION_STILL = 'still';

/** Props for the world element: still on dense WebKit boards, unchanged otherwise. */
export function worldMotionProps(dense, view = globalThis) {
  return dense && webkitCompositing(view) ? { [WORLD_MOTION_ATTRIBUTE]: WORLD_MOTION_STILL } : {};
}
