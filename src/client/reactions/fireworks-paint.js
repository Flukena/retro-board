// Paints fireworks shows onto a 2D canvas. Positions come from the pure timeline; colours from the sticky palette.
import { PALETTE } from '../ui/palette.js';
import { sparkAt } from './reaction-timeline.js';

// Sparks are soft streaks: a 3x retina backing store would cost more than it shows.
export const MAX_CANVAS_PIXEL_RATIO = 2;
// Each spark is drawn as a streak from where it was this long ago to where it is now.
const SPARK_TRAIL_MS = 90;
const ROUND_CAP = 'round';
const OPAQUE = 1;
const DIAMETER_PER_RADIUS = 2;

/** Sizes the backing store to the viewport (only when it changed) and returns the drawing size in CSS pixels. */
export function fitCanvas(canvas, context, { innerWidth, innerHeight, devicePixelRatio = 1 }) {
  const ratio = Math.min(devicePixelRatio, MAX_CANVAS_PIXEL_RATIO);
  const width = Math.round(innerWidth * ratio);
  const height = Math.round(innerHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width: innerWidth, height: innerHeight };
}

function paintSpark(context, spark, elapsedMs, viewport) {
  const head = sparkAt(spark, elapsedMs, viewport);
  if (!head) return false;
  const tail = sparkAt(spark, Math.max(spark.delayMs, elapsedMs - SPARK_TRAIL_MS), viewport) ?? head;
  context.globalAlpha = head.alpha;
  context.strokeStyle = PALETTE[spark.colour].border;
  context.lineWidth = head.radiusPx * DIAMETER_PER_RADIUS;
  context.beginPath();
  context.moveTo(tail.x, tail.y);
  context.lineTo(head.x, head.y);
  context.stroke();
  return true;
}

/** Clears the canvas and paints every visible spark of `shows` at `now`; returns how many sparks it drew. */
export function paintFireworks(context, shows, now, viewport) {
  context.clearRect(0, 0, viewport.width, viewport.height);
  context.lineCap = ROUND_CAP;
  let drawn = 0;
  for (const show of shows) {
    const elapsedMs = now - show.startedAt;
    for (const spark of show.sparks) if (paintSpark(context, spark, elapsedMs, viewport)) drawn += 1;
  }
  context.globalAlpha = OPAQUE;
  return drawn;
}
