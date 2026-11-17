import React, { useEffect, useMemo, useRef, useState } from 'react';
import { portalToBody } from '../ui/UiPrimitives.jsx';
import { useReducedMotion } from '../ui/usePresence.js';
import { t } from '../ui/i18n.js';
import { FLOAT_DURATION_MS, REACTION_LOOK } from './reaction-timeline.js';
import { addReaction, liveReactions, nextExpiryInMs, reactionEntry, withoutMotion } from './reaction-feed.js';
import {
  animateFireworks, fireworksLook, fitCanvas, paintFireworks, showsRunning,
} from './fireworks-paint.js';
import './reactions.css';

const NO_ENTRIES = Object.freeze([]);
// Expire a frame after the earliest end, so the timer never fires just before it and has to re-arm.
const EXPIRY_MARGIN_MS = 16;
const CANVAS_CONTEXT = '2d';
// Shows start on the wall clock (reaction-feed entries), so frames are timed on it too.
const BROWSER_FRAMES = Object.freeze({
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (frame) => cancelAnimationFrame(frame),
  clock: () => Date.now(),
});
const readThemeToken = (name) => getComputedStyle(document.documentElement).getPropertyValue(name);

/** One canvas for every running show; its frames stop once the shows end, when they change, or on unmount. */
function FireworksCanvas({ shows }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext(CANVAS_CONTEXT);
    if (!context) return undefined;
    const look = fireworksLook(readThemeToken);
    const paint = (now) => paintFireworks(context, shows, now, fitCanvas(canvas, context, window), look);
    return animateFireworks(paint, (now) => showsRunning(shows, now), BROWSER_FRAMES);
  }, [shows]);
  return <canvas ref={canvasRef} className="rb-reaction-fireworks" data-reaction-look={REACTION_LOOK.FIREWORKS} />;
}

/** A floating emoji with its sender's name, or (reduced motion) the same badge held still. */
function ReactionBadge({ entry }) {
  const style = {
    '--rb-reaction-left': `${entry.placement.leftPercent}%`,
    '--rb-reaction-drift': `${entry.placement.driftPx}px`,
    '--rb-reaction-ms': `${FLOAT_DURATION_MS}ms`,
  };
  return (
    <span className={`rb-reaction-badge rb-reaction-badge--${entry.look}`} data-reaction-look={entry.look} style={style}>
      <span className="rb-reaction-badge__emoji">{entry.emoji}</span>
      <span className="rb-reaction-badge__name">{entry.name || t('reaction.someone')}</span>
    </span>
  );
}

/** Draws the given effect entries; decorative, so hidden from assistive technology. */
export function ReactionEffects({ entries }) {
  const shows = useMemo(() => entries.filter((entry) => entry.look === REACTION_LOOK.FIREWORKS), [entries]);
  if (!entries.length) return null;
  return (
    <div className="rb-reaction-layer" aria-hidden="true">
      {shows.length > 0 && <FireworksCanvas shows={shows} />}
      {entries.filter((entry) => entry.look !== REACTION_LOOK.FIREWORKS)
        .map((entry) => <ReactionBadge key={entry.key} entry={entry} />)}
    </div>
  );
}

/** Live effect entries from `channel`, each dropped when its effect ends. */
function useReactionFeed(channel) {
  const reducedMotion = useReducedMotion();
  const [entries, setEntries] = useState(NO_ENTRIES);
  useEffect(() => channel.subscribe((event) => {
    const now = Date.now();
    setEntries((current) => addReaction(current, reactionEntry(event, { reducedMotion, now }), now));
  }), [channel, reducedMotion]);
  useEffect(() => {
    if (reducedMotion) setEntries(withoutMotion);
  }, [reducedMotion]);
  useEffect(() => {
    const waitMs = nextExpiryInMs(entries, Date.now());
    if (waitMs === null) return undefined;
    const timer = setTimeout(() => setEntries((current) => liveReactions(current, Date.now())), waitMs + EXPIRY_MARGIN_MS);
    return () => clearTimeout(timer);
  }, [entries]);
  return entries;
}

/** Everyone's reactions, over the board and under popovers and modals. */
export function ReactionOverlay({ channel }) {
  const entries = useReactionFeed(channel);
  return entries.length ? portalToBody(<ReactionEffects entries={entries} />) : null;
}
