import test from 'node:test';
import assert from 'node:assert/strict';
import { FIREWORKS_DURATION_MS, REACTION_LOOK } from './reaction-timeline.js';
import { MAX_PARTICLES_PER_SHOW, particleCount } from './fireworks-physics.js';
import { REACTION_PLAY_INTERVAL_MS } from './reaction-receiver.js';
import {
  MAX_ACTIVE_BY_LOOK, MAX_ACTIVE_FIREWORKS_SHOWS, MAX_ACTIVE_PARTICLES, addReaction, liveReactions, nextExpiryInMs, reactionEntry, withoutMotion,
} from './reaction-feed.js';

const NOW_MS = 1_700_000_000_000;
const MOTION = Object.freeze({ reducedMotion: false, now: NOW_MS });
const event = (clientId, seq, emoji = '👏', name = 'Ada') => ({ clientId, seq, emoji, name });

test('an entry carries what to draw: a fireworks show, or a lane for floats and stills', () => {
  const fireworks = reactionEntry(event(1, 1, '🎆'), MOTION);
  assert.equal(fireworks.look, REACTION_LOOK.FIREWORKS);
  assert.ok(fireworks.fireworks.shells.length > 0);
  assert.equal(fireworks.placement, null);
  assert.equal(fireworks.endsAt, NOW_MS + FIREWORKS_DURATION_MS);
  const float = reactionEntry(event(1, 2, '🔥', 'บี'), MOTION);
  assert.equal(float.look, REACTION_LOOK.FLOAT);
  assert.equal(float.name, 'บี');
  assert.ok(float.placement.leftPercent > 0);
  const still = reactionEntry(event(1, 3, '🎆'), { ...MOTION, reducedMotion: true });
  assert.equal(still.look, REACTION_LOOK.STILL);
  assert.equal(still.fireworks, null, 'reduced motion never builds particles');
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
  const particles = entries.reduce((sum, entry) => sum + (entry.fireworks ? particleCount(entry.fireworks) : 0), 0);
  assert.ok(particles <= MAX_ACTIVE_PARTICLES);
  assert.equal(MAX_ACTIVE_PARTICLES, MAX_ACTIVE_BY_LOOK[REACTION_LOOK.FIREWORKS] * MAX_PARTICLES_PER_SHOW);
});

// The ruling on the cap: when one sender is admitted every play interval, their 4th show ends their oldest one during
// its last ~0.4 s of fade.
const OLDEST_SHOW_CUT_WITHIN_MS = 400;

test('at most three fireworks shows run at once; a sender played every play interval loses the oldest in its last 0.4 s', () => {
  const playAt = (index) => NOW_MS + index * REACTION_PLAY_INTERVAL_MS;
  const play = (entries, index) => addReaction(
    entries, reactionEntry(event(1, index + 1, '🎆'), { ...MOTION, now: playAt(index) }), playAt(index),
  );
  let entries = [];
  for (let index = 0; index < MAX_ACTIVE_FIREWORKS_SHOWS; index += 1) entries = play(entries, index);
  assert.equal(MAX_ACTIVE_FIREWORKS_SHOWS, 3);
  assert.equal(entries.length, MAX_ACTIVE_FIREWORKS_SHOWS, 'the first three shows all run');
  const [oldest] = entries;
  const cutAt = playAt(MAX_ACTIVE_FIREWORKS_SHOWS);
  entries = play(entries, MAX_ACTIVE_FIREWORKS_SHOWS);
  assert.equal(entries.length, MAX_ACTIVE_FIREWORKS_SHOWS, 'the cap holds');
  assert.deepEqual(entries.map((entry) => entry.key), ['1:2', '1:3', '1:4'], 'the oldest show is the one dropped');
  const cutShortByMs = oldest.endsAt - cutAt;
  assert.ok(cutShortByMs > 0, 'the oldest show was still running');
  assert.ok(cutShortByMs <= OLDEST_SHOW_CUT_WITHIN_MS, `cut ${cutShortByMs} ms before its end`);
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
  const [first, last] = [fireworks, float].sort((one, other) => one.endsAt - other.endsAt);
  assert.ok(first.endsAt < last.endsAt);
  assert.equal(nextExpiryInMs(entries, NOW_MS + 500), first.endsAt - (NOW_MS + 500));
  assert.deepEqual(liveReactions(entries, first.endsAt).map((entry) => entry.key), [last.key]);
  assert.deepEqual(liveReactions(entries, last.endsAt), []);
  assert.equal(nextExpiryInMs([], NOW_MS), null);
  assert.equal(nextExpiryInMs(entries, last.endsAt + 1), 0, 'overdue entries expire at once');
});

test('adding also drops anything already finished', () => {
  const old = reactionEntry(event(1, 1), MOTION);
  const later = reactionEntry(event(1, 2), { ...MOTION, now: old.endsAt + 1 });
  assert.deepEqual(addReaction([old], later, old.endsAt + 1).map((entry) => entry.key), [later.key]);
});

test('turning on reduced motion mid-show removes running fireworks and floats at once, keeping still badges', () => {
  let entries = [];
  entries = addReaction(entries, reactionEntry(event(1, 1, '🎆'), MOTION), NOW_MS);
  entries = addReaction(entries, reactionEntry(event(2, 1, '👏'), MOTION), NOW_MS);
  const still = reactionEntry(event(3, 1, '❤️'), { ...MOTION, reducedMotion: true });
  entries = addReaction(entries, still, NOW_MS);
  assert.deepEqual(withoutMotion(entries).map(({ key }) => key), [still.key]);
  assert.ok(Object.isFrozen(withoutMotion(entries)));
});
