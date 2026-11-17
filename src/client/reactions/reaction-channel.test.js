import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { BOARD_REACTION_FIELD, boardReaction } from '../../domain/board-reactions.js';
import { DISPLAY_NAME_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { REACTION_SEND_INTERVAL_MS } from './reaction-rate-limiter.js';
import { REACTION_CLEAR_MS, createReactionChannel } from './reaction-channel.js';

const START_MS = 1_700_000_000_000;
const RELAY = 'relay';

/** One page: a doc, its awareness, and a clock the test moves. */
function page(t, name) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', { userId: `id-${name}`, name });
  const clock = { now: START_MS };
  t.after(() => { awareness.destroy(); doc.destroy(); });
  return { doc, awareness, clock, open: () => createReactionChannel(awareness, { now: () => clock.now }) };
}

/** Relays each page's own awareness changes to the other, as the board relay does. */
function link(...pages) {
  for (const from of pages) {
    from.awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin === RELAY) return;
      const own = [...added, ...updated, ...removed].filter((id) => id === from.awareness.clientID);
      if (!own.length) return;
      const update = encodeAwarenessUpdate(from.awareness, own);
      pages.filter((to) => to !== from).forEach((to) => applyAwarenessUpdate(to.awareness, update, RELAY));
    });
  }
}

/** Introduces two pages that were already connected before the test acts. */
function introduce(a, b) {
  applyAwarenessUpdate(b.awareness, encodeAwarenessUpdate(a.awareness, [a.awareness.clientID]), RELAY);
  applyAwarenessUpdate(a.awareness, encodeAwarenessUpdate(b.awareness, [b.awareness.clientID]), RELAY);
}

const record = (channel) => {
  const seen = [];
  channel.subscribe((event) => seen.push(event));
  return seen;
};

test('A sends fireworks and B plays them once, with A as the sender; A also plays its own once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = page(t, 'Ada');
  const b = page(t, 'บี');
  link(a, b);
  introduce(a, b);
  const channelA = a.open();
  const channelB = b.open();
  const atA = record(channelA);
  const atB = record(channelB);
  assert.equal(channelA.send('🎆'), true);
  assert.deepEqual(atB.map(({ emoji, name, clientId, seq }) => ({ emoji, name, clientId, seq })),
    [{ emoji: '🎆', name: 'Ada', clientId: a.awareness.clientID, seq: 1 }]);
  assert.deepEqual(atA.map(({ emoji, name }) => ({ emoji, name })), [{ emoji: '🎆', name: 'Ada' }]);
  a.awareness.setLocalStateField('cursor', { x: 1, y: 2 });
  t.mock.timers.tick(REACTION_CLEAR_MS);
  assert.equal(atB.length, 1, 'later presence changes and the clear do not replay');
  assert.equal(atA.length, 1);
});

test('B sends a float and A sees it with B’s name', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = page(t, 'Ada');
  const b = page(t, 'บี');
  link(a, b);
  introduce(a, b);
  const atA = record(a.open());
  b.open().send('👏');
  assert.deepEqual(atA.map(({ emoji, name }) => ({ emoji, name })), [{ emoji: '👏', name: 'บี' }]);
});

test('sends inside the interval are dropped; the next one after it goes out with the next seq', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = page(t, 'Ada');
  const b = page(t, 'Bee');
  link(a, b);
  introduce(a, b);
  const channelA = a.open();
  const atB = record(b.open());
  assert.equal(channelA.send('👍'), true);
  a.clock.now += REACTION_SEND_INTERVAL_MS / 2;
  assert.equal(channelA.send('🔥'), false);
  assert.ok(channelA.cooldownMs() > 0);
  a.clock.now += REACTION_SEND_INTERVAL_MS / 2;
  assert.equal(channelA.cooldownMs(), 0);
  assert.equal(channelA.send('🔥'), true);
  assert.deepEqual(atB.map(({ emoji, seq }) => `${emoji}${seq}`), ['👍1', '🔥2']);
});

test('the field is cleared after it has had time to reach every peer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = page(t, 'Ada');
  const channel = a.open();
  channel.send('❤️');
  assert.equal(a.awareness.getLocalState()[BOARD_REACTION_FIELD].emoji, '❤️');
  t.mock.timers.tick(REACTION_CLEAR_MS - 1);
  assert.notEqual(a.awareness.getLocalState()[BOARD_REACTION_FIELD], null);
  t.mock.timers.tick(1);
  assert.equal(a.awareness.getLocalState()[BOARD_REACTION_FIELD], null);
  assert.equal(a.awareness.getLocalState().user.name, 'Ada', 'other presence fields are kept');
});

test('a peer who joins while a reaction is live does not replay it, but plays the next one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = page(t, 'Ada');
  const late = page(t, 'Late');
  const channelA = a.open();
  channelA.send('🎆');
  const atLate = record(late.open());
  link(a, late);
  introduce(a, late);
  assert.deepEqual(atLate, []);
  a.clock.now += REACTION_SEND_INTERVAL_MS;
  channelA.send('😂');
  assert.deepEqual(atLate.map(({ emoji }) => emoji), ['😂']);
});

test('only whitelisted emoji are sent, and nothing reaches the board document or its undo history', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = page(t, 'Ada');
  const undo = new Y.UndoManager([a.doc.getMap('items'), a.doc.getMap('meta')], { trackedOrigins: new Set(['local', null]) });
  let docUpdates = 0;
  a.doc.on('update', () => { docUpdates += 1; });
  const channel = a.open();
  assert.equal(channel.send('🎉'), false);
  assert.equal(channel.send('<img>'), false);
  assert.equal(a.awareness.getLocalState()[BOARD_REACTION_FIELD], undefined);
  assert.equal(channel.send('🎆'), true);
  t.mock.timers.tick(REACTION_CLEAR_MS);
  assert.equal(docUpdates, 0);
  assert.equal(undo.undoStack.length, 0);
});

test('the sender name is trimmed and bounded; a missing name is empty for the UI to replace', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = page(t, 'Ada');
  const b = page(t, 'Bee');
  link(a, b);
  introduce(a, b);
  const atB = record(b.open());
  const channelA = a.open();
  a.awareness.setLocalStateField('user', { name: `  ${'n'.repeat(DISPLAY_NAME_MAX_LENGTH + 5)}  ` });
  channelA.send('👍');
  a.awareness.setLocalStateField('user', { name: 42 });
  a.clock.now += REACTION_SEND_INTERVAL_MS;
  channelA.send('👍');
  assert.equal(atB[0].name, 'n'.repeat(DISPLAY_NAME_MAX_LENGTH));
  assert.equal(atB[1].name, '');
});

test('destroy stops delivery, cancels the clear timer and leaves no reaction behind', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = page(t, 'Ada');
  const channel = a.open();
  const seen = record(channel);
  channel.send('🔥');
  channel.destroy();
  assert.equal(a.awareness.getLocalState()[BOARD_REACTION_FIELD], null);
  a.clock.now += REACTION_SEND_INTERVAL_MS;
  assert.equal(channel.send('👍'), false);
  t.mock.timers.tick(REACTION_CLEAR_MS);
  a.awareness.setLocalStateField(BOARD_REACTION_FIELD, boardReaction('👍', 99, a.clock.now));
  assert.equal(seen.length, 1, 'no delivery after destroy');
});
