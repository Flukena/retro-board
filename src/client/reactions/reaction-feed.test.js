import test from 'node:test';
import assert from 'node:assert/strict';
import { FIREWORKS_DURATION_MS, MAX_SPARKS_PER_SHOW, REACTION_LOOK } from './reaction-timeline.js';
import {
  MAX_ACTIVE_BY_LOOK, MAX_ACTIVE_SPARKS, addReaction, liveReactions, nextExpiryInMs, reactionEntry,
} from './reaction-feed.js';

const NOW_MS = 1_700_000_000_000;
const MOTION = Object.freeze({ reducedMotion: false, now: NOW_MS });
const event = (clientId, seq, emoji = '👏', name = 'Ada') => ({ clientId, seq, emoji, name });

test('an entry carries what to draw: sparks for fireworks, a lane for floats and stills', () => {
  const fireworks = reactionEntry(event(1, 1, '🎆'), MOTION);
  assert.equal(fireworks.look, REACTION_LOOK.FIREWORKS);
  assert.ok(fireworks.sparks.length > 0);
  assert.equal(fireworks.endsAt, NOW_MS + FIREWORKS_DURATION_MS);
  const float = reactionEntry(event(1, 2, '🔥', 'บี'), MOTION);
  assert.equal(float.look, REACTION_LOOK.FLOAT);
  assert.equal(float.name, 'บี');
  assert.ok(float.placement.leftPercent > 0);
  const still = reactionEntry(event(1, 3, '🎆'), { ...MOTION, reducedMotion: true });
  assert.equal(still.look, REACTION_LOOK.STILL);
  assert.equal(still.sparks, null, 'reduced motion never builds particles');
  assert.notEqual(float.key, still.key);
});

test('concurrent effects stay bounded per look, dropping the oldest, so many senders cannot flood a slow laptop', () => {
  const SENDERS = 40;
  let entries = [];
  for (let clientId = 1; clientId <= SENDERS; clientId += 1) {
    entries = addReaction(entries, reactionEntry(event(clientId, 1, '🎆'), MOTION), NOW_MS);
    entries = addReaction(entries, reactionEntry(event(clientId, 2, '👍'), MOTION), NOW_MS);
    entries = addReaction(entries, reactionEntry(event(clientId, 3, '❤️'), { ...MOTION, reducedMotion: true }), NOW_MS);
  }
  for (const look of Object.values(REACTION_LOOK)) {
    const ofLook = entries.filter((entry) => entry.look === look);
    assert.equal(ofLook.length, MAX_ACTIVE_BY_LOOK[look], look);
    assert.equal(ofLook.at(-1).key, `${SENDERS}:${ofLook.at(-1).key.split(':')[1]}`, `${look}: newest kept`);
  }
  const sparks = entries.reduce((sum, entry) => sum + (entry.sparks?.length ?? 0), 0);
  assert.ok(sparks <= MAX_ACTIVE_SPARKS);
  assert.equal(MAX_ACTIVE_SPARKS, MAX_ACTIVE_BY_LOOK[REACTION_LOOK.FIREWORKS] * MAX_SPARKS_PER_SHOW);
});

test('the same key is never shown twice', () => {
  const entry = reactionEntry(event(9, 1), MOTION);
  const entries = addReaction(addReaction([], entry, NOW_MS), entry, NOW_MS);
  assert.equal(entries.length, 1);
});

test('finished effects are dropped and the next expiry is when the earliest one ends', () => {
  const fireworks = reactionEntry(event(1, 1, '🎆'), MOTION);
  const float = reactionEntry(event(2, 1, '👏'), { ...MOTION, now: NOW_MS + 100 });
  const entries = addReaction(addReaction([], fireworks, NOW_MS), float, NOW_MS + 100);
  assert.equal(nextExpiryInMs(entries, NOW_MS + 500), fireworks.endsAt - (NOW_MS + 500));
  assert.deepEqual(liveReactions(entries, fireworks.endsAt).map((entry) => entry.key), [float.key]);
  assert.deepEqual(liveReactions(entries, float.endsAt), []);
  assert.equal(nextExpiryInMs([], NOW_MS), null);
  assert.equal(nextExpiryInMs(entries, float.endsAt + 1), 0, 'overdue entries expire at once');
});

test('adding also drops anything already finished', () => {
  const old = reactionEntry(event(1, 1), MOTION);
  const later = reactionEntry(event(1, 2), { ...MOTION, now: old.endsAt + 1 });
  assert.deepEqual(addReaction([old], later, old.endsAt + 1).map((entry) => entry.key), [later.key]);
});
