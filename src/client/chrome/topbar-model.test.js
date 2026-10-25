import test from 'node:test';
import assert from 'node:assert/strict';
import { adminPillModel, playerRows, shareLinkModel, transferCandidates } from './topbar-model.js';

test('admin name falls back from presence to cached name to localized admin', () => {
  const input = { adminUserId: 'admin', adminName: 'Cached', presence: {}, onlineUsers: [], fallbackName: 'ผู้ดูแล' };
  assert.equal(adminPillModel(input).name, 'Cached');
  assert.deepEqual(adminPillModel({ ...input, adminName: '' }), { name: 'ผู้ดูแล', isOnline: false });
  assert.deepEqual(adminPillModel({ ...input, presence: { admin: { name: 'Present' } }, onlineUsers: [{ userId: 'admin' }] }), { name: 'Present', isOnline: true });
  assert.equal(adminPillModel({ ...input, adminUserId: null }), null);
});
test('players reflect identity, following and strictest active vote limit', () => {
  const rows = playerRows({ onlineUsers: [{ userId: 'me', name: 'Me' }, { userId: 'other', name: 'Other' }], userId: 'me', adminUserId: 'other', followedUserId: 'other', votesUsedByUser: new Map([['other', 3]]), limit: 3 });
  assert.deepEqual(rows[0], { userId: 'me', name: 'Me', isMe: true, isAdmin: false, isFollowing: false, used: 0, limit: 3, isFull: false });
  assert.equal(rows[1].isAdmin, true);
  assert.equal(rows[1].isFollowing, true);
  assert.equal(rows[1].isFull, true);
  assert.equal(playerRows({ onlineUsers: [{ userId: 'other' }], votesUsedByUser: new Map([['other', 100]]), limit: null })[0].isFull, false);
});
test('share link includes capability fragment and manual fallback retains it', () => {
  assert.deepEqual(shareLinkModel('https://retro.example', 'room', 'secret'), { url: 'https://retro.example/b/room#secret', manualCode: 'room#secret' });
  assert.deepEqual(shareLinkModel('https://retro.example', 'room', ''), { url: 'https://retro.example/b/room', manualCode: 'room' });
});

test('transfer candidates exclude the current user and preserve online order', () => {
  const me = { userId: 'me', isMe: true };
  const first = { userId: 'first', isMe: false };
  const second = { userId: 'second', isMe: false };
  assert.deepEqual(transferCandidates([first, me, second]), [first, second]);
  assert.deepEqual(transferCandidates([me]), []);
});
