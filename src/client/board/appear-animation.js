// The appear pop scales an item, so WebKit gives it its own composited layer
// while the animation runs. That layer is sized from the item's own CSS size
// times DPR², not from the board zoom: a 10,000×7,200px zone on a DPR-3 iPhone
// needs about 2.6 GB, over Safari's per-tab memory limit, and zooming out to a
// large board mounts many such items at once. Larger items appear without it.
export const APPEAR_ANIMATION = 'rb-appear 0.28s ease-out';
// 1,000,000 CSS px² is about 36 MB of layer at DPR 3.
export const APPEAR_ANIMATION_MAX_AREA_CSS_PX2 = 1_000_000;

/** The appear animation for an item of this size, or undefined when it is too large to animate. */
export function appearAnimation({ w, h }) {
  const area = w * h;
  return Number.isFinite(area) && area > APPEAR_ANIMATION_MAX_AREA_CSS_PX2 ? undefined : APPEAR_ANIMATION;
}
