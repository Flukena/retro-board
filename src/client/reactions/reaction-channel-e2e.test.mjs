import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_REACTION_FIELD } from '../../domain/board-reactions.js';
import { E2E_FRAME } from '../../domain/e2e-envelope.js';
import { e2eRoom, roomKey, synced, until } from '../../test-support/e2e-room-fixture.mjs';
import { createReactionChannel } from './reaction-channel.js';

const QUIET_MS = 200;
const PLAINTEXT_NEEDLES = Object.freeze([Buffer.from('🎆'), Buffer.from(BOARD_REACTION_FIELD), Buffer.from('Ada')]);

const containsPlaintext = (frame) => Object.values(frame ?? {}).some((value) => value instanceof Uint8Array
  && PLAINTEXT_NEEDLES.some((needle) => Buffer.from(value).includes(needle)));

test('on a locked board the reaction crosses the real E2E relay encrypted, and B plays it once', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key);
  const b = room.join(key);
  await synced(a, b);
  a.provider.awareness.setLocalStateField('user', { userId: 'a', name: 'Ada' });
  await until(() => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === 'Ada', 'B sees A');
  const channelA = createReactionChannel(a.provider.awareness);
  const channelB = createReactionChannel(b.provider.awareness);
  t.after(() => { channelA.destroy(); channelB.destroy(); });
  const atB = [];
  channelB.subscribe((event) => atB.push(event));
  assert.equal(channelA.send('🎆'), true);
  await until(() => atB.length > 0, 'B plays the reaction');
  await new Promise((resolve) => { setTimeout(resolve, QUIET_MS); });
  assert.deepEqual(atB.map(({ emoji, name }) => ({ emoji, name })), [{ emoji: '🎆', name: 'Ada' }]);
  const ephemeral = a.tap.sentOfType(E2E_FRAME.EPHEMERAL);
  assert.ok(ephemeral.length > 0, 'presence went out as E2E ephemeral frames');
  assert.equal(a.tap.sent.filter(containsPlaintext).length, 0, 'no frame A sent carries the emoji, field or name in clear');
  assert.equal(b.tap.received.filter(containsPlaintext).length, 0, 'nor does any frame B received');
});
