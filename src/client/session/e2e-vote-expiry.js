import * as Y from 'yjs';
import { finalizeExpiredVotes } from '../../domain/vote-expiry.js';
import { E2E_SYNCED_FIELD } from './e2e-provider.js';

/** Non-elected pages wait this long past the deadline before finalizing a timer that is still live. */
export const E2E_VOTE_GRACE_MS = 10_000;
const ITEMS_MAP_KEY = 'items';
const ITEM_TYPE_KEY = 'type';
const ZONE_TYPE = 'zone';
const VOTE_TIMER_KEY = 'voteTimer';
const defaultTimers = Object.freeze({
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  now: () => Date.now(),
});
const INVALID_GEOMETRY_LOG = '[e2e] vote results skipped: invalid geometry';
const generationKey = ({ endsAt, startedAt }) => `${endsAt}|${startedAt}`;
const warnInvalidGeometry = () => console.warn(INVALID_GEOMETRY_LOG);

/** The awareness clientID that finalizes at the deadline: the lowest among pages advertising e2eSynced. */
export function electedFinalizer(awareness) {
  let elected = null;
  awareness.getStates().forEach((state, clientID) => {
    if (state?.[E2E_SYNCED_FIELD] === true && (elected === null || clientID < elected)) elected = clientID;
  });
  return elected;
}

/** The earliest live vote timer (its generation), ignoring generations this page already acted on. */
function earliestTimer(yItems, attempted) {
  let earliest = null;
  yItems.forEach((item) => {
    if (!(item instanceof Y.Map) || item.get(ITEM_TYPE_KEY) !== ZONE_TYPE) return;
    const timer = item.get(VOTE_TIMER_KEY);
    if (!Number.isFinite(timer?.endsAt)) return;
    const generation = { endsAt: timer.endsAt, startedAt: timer.startedAt };
    if (attempted.has(generationKey(generation))) return;
    if (earliest === null || generation.endsAt < earliest.endsAt) earliest = generation;
  });
  return earliest;
}

/**
 * Timed-vote expiry for an encrypted room, where the relay cannot read the board (Deviation 7). Only a page that
 * holds the whole log acts: the elected one at the deadline, the others after a grace if the timer is still live.
 */
export function attachE2EVoteExpiry({
  ydoc, provider, graceMs = E2E_VOTE_GRACE_MS, timers = defaultTimers, onInvalidGeometry = warnInvalidGeometry,
}) {
  const yItems = ydoc.getMap(ITEMS_MAP_KEY);
  const { awareness } = provider;
  const attempted = new Set();
  let timer = null;
  let signature = '';
  const currentSignature = () => `${electedFinalizer(awareness) === ydoc.clientID}|${provider.e2eSynced}`;

  function arm() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    signature = currentSignature();
    const generation = earliestTimer(yItems, attempted);
    if (generation === null) return;
    const elected = electedFinalizer(awareness) === ydoc.clientID;
    const actAt = generation.endsAt + (elected ? 0 : graceMs);
    timer = timers.setTimeout(() => act(generation), Math.max(0, actAt - timers.now()));
  }

  function act(generation) {
    timer = null;
    if (!provider.e2eSynced) return; // Re-armed when this page holds the whole log again.
    // Timers may fire a little before the wall clock reaches the deadline; finalizing then would find nothing due.
    if (timers.now() < generation.endsAt) {
      arm();
      return;
    }
    attempted.add(generationKey(generation));
    finalizeExpiredVotes(ydoc, Y, awareness, timers.now(), onInvalidGeometry, { timerGeneration: generation });
    arm();
  }

  const onAwareness = () => { if (currentSignature() !== signature) arm(); };
  yItems.observeDeep(arm);
  awareness.on('change', onAwareness);
  arm();
  return {
    destroy() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      yItems.unobserveDeep(arm);
      awareness.off('change', onAwareness);
    },
  };
}
