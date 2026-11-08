import { readVoteResultParticipants } from './vote-result-participants.js';
import { readCanonicalVotes } from './canonical-votes.js';
import { planVoteFinalization } from './vote-finalization.js';
import { geometryErrorForPatch } from './board-geometry.js';

const ITEMS_MAP_KEY = 'items';
const VOTES_MAP_KEY = 'kv';
const META_MAP_KEY = 'meta';
const ALL_REVEALED_KEY = 'allRevealed';
const ZONE_TYPE = 'zone';
const ITEM_TYPE_KEY = 'type';
const VOTE_TIMER_KEY = 'voteTimer';
const TIMER_EXPIRY_ORIGIN = 'timer-expiry';
const NO_AWARENESS = Object.freeze({ getStates: () => new Map(), meta: new Map() });

const matchesGeneration = (timer, generation) => !generation
  || (timer?.endsAt === generation.endsAt && timer?.startedAt === generation.startedAt);

const expiredZones = (yItems, Y, atTime, generation) => {
  const expired = [];
  yItems.forEach((item, id) => {
    if (!(item instanceof Y.Map) || item.get(ITEM_TYPE_KEY) !== ZONE_TYPE) return;
    const timer = item.get(VOTE_TIMER_KEY);
    const deadline = timer?.endsAt;
    if (Number.isFinite(deadline) && deadline <= atTime && matchesGeneration(timer, generation)) expired.push(id);
  });
  return expired;
};

const flattenItems = (yItems, Y) => {
  const items = [];
  const itemsById = new Map();
  yItems.forEach((yItem, id) => {
    if (!(yItem instanceof Y.Map)) return;
    const item = { id };
    yItem.forEach((value, key) => { item[key] = value instanceof Y.Text ? value.toString() : value; });
    items.push(item);
    if (!itemsById.has(item.id)) itemsById.set(item.id, item);
  });
  return { items, itemsById };
};

const applyPlan = (ydoc, yItems, zoneId, plan, Y, atTime, generation) => {
  ydoc.transact(() => {
    const liveTimer = yItems.get(zoneId)?.get(VOTE_TIMER_KEY);
    if (!liveTimer?.endsAt || liveTimer.endsAt > atTime || !matchesGeneration(liveTimer, generation)) return;
    plan.entries.forEach(({ id, patch }) => {
      const yItem = yItems.get(id);
      if (!(yItem instanceof Y.Map)) return;
      Object.entries(patch).forEach(([key, value]) => yItem.set(key, value));
    });
  }, TIMER_EXPIRY_ORIGIN);
};

const planIsInvalid = (plan, itemsById) => !plan || plan.entries.some((entry) => {
  const current = itemsById.get(entry.id);
  return !current || geometryErrorForPatch(current, entry.patch);
});

export const finalizeExpiredVotes = (ydoc, Y, awareness, atTime, onInvalidGeometry, { timerGeneration } = {}) => {
  const yItems = ydoc.getMap(ITEMS_MAP_KEY);
  const expired = expiredZones(yItems, Y, atTime, timerGeneration);
  if (!expired.length) return;
  const participants = readVoteResultParticipants(awareness ?? NO_AWARENESS, atTime);
  const { items, itemsById } = flattenItems(yItems, Y);
  const votesByItem = readCanonicalVotes(ydoc.getMap(VOTES_MAP_KEY));
  const allRevealed = ydoc.getMap(META_MAP_KEY).get(ALL_REVEALED_KEY) === true;
  for (const zoneId of expired) {
    const plan = planVoteFinalization(items, votesByItem, zoneId, atTime, participants, allRevealed);
    if (planIsInvalid(plan, itemsById)) { onInvalidGeometry(); continue; }
    applyPlan(ydoc, yItems, zoneId, plan, Y, atTime, timerGeneration);
  }
};
