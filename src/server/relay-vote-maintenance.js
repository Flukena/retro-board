import { readVoteResultParticipants } from '../domain/vote-result-participants.js';
import { readCanonicalVotes } from '../domain/canonical-votes.js';
import { planVoteFinalization } from '../domain/vote-finalization.js';
import { geometryErrorForPatch } from '../domain/board-geometry.js';

const ITEMS_MAP_KEY = 'items';
const VOTES_MAP_KEY = 'kv';
const META_MAP_KEY = 'meta';
const ALL_REVEALED_KEY = 'allRevealed';
const ZONE_TYPE = 'zone';
const ITEM_TYPE_KEY = 'type';
const VOTE_TIMER_KEY = 'voteTimer';
const TIMER_EXPIRY_ORIGIN = 'timer-expiry';

const expiredZones = (yItems, Y, atTime) => {
  const expired = [];
  yItems.forEach((item, id) => {
    if (!(item instanceof Y.Map) || item.get(ITEM_TYPE_KEY) !== ZONE_TYPE) return;
    const deadline = item.get(VOTE_TIMER_KEY)?.endsAt;
    if (Number.isFinite(deadline) && deadline <= atTime) expired.push(id);
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

const applyPlan = (ydoc, yItems, zoneId, plan, Y, atTime) => {
  ydoc.transact(() => {
    const liveTimer = yItems.get(zoneId)?.get(VOTE_TIMER_KEY);
    if (!liveTimer?.endsAt || liveTimer.endsAt > atTime) return;
    plan.entries.forEach(({ id, patch }) => {
      const yItem = yItems.get(id);
      if (!(yItem instanceof Y.Map)) return;
      Object.entries(patch).forEach(([key, value]) => yItem.set(key, value));
    });
  }, TIMER_EXPIRY_ORIGIN);
};

export const finalizeRelayVotes = (ydoc, Y, atTime, invalidGeometry) => {
  const yItems = ydoc.getMap(ITEMS_MAP_KEY);
  const expired = expiredZones(yItems, Y, atTime);
  if (!expired.length) return;
  const participants = readVoteResultParticipants(ydoc.awareness, atTime);
  const { items, itemsById } = flattenItems(yItems, Y);
  const votesByItem = readCanonicalVotes(ydoc.getMap(VOTES_MAP_KEY));
  for (const zoneId of expired) {
    const plan = planVoteFinalization(items, votesByItem, zoneId, atTime, participants,
      ydoc.getMap(META_MAP_KEY).get(ALL_REVEALED_KEY) === true);
    if (!plan || plan.entries.some((entry) => {
      const current = itemsById.get(entry.id);
      return !current || geometryErrorForPatch(current, entry.patch);
    })) {
      invalidGeometry();
      continue;
    }
    applyPlan(ydoc, yItems, zoneId, plan, Y, atTime);
  }
};

export const maintainRoomVotes = (docs, finalize, atTime, onError) => {
  for (const [name, doc] of docs) {
    try { finalize(name, doc, atTime); }
    catch (err) { onError(name, err); }
  }
};
