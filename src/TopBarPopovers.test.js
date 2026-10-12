import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('transfer emits the selected identity and closes; follow emits then closes', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { TransferRow, PlayerRow } = await server.ssrLoadModule('/src/TopBarPopovers.jsx');
    const events = [];
    TransferRow({ player: { userId: 'other' }, onTransferAdmin: (id) => events.push(id), onClose: () => events.push('close') }).props.onClick();
    assert.deepEqual(events, ['close', 'other']);
    events.length = 0;
    const row = PlayerRow({ player: { userId: 'other', used: 0, limit: null }, onFollow: (id) => events.push(id), onClose: () => events.push('close') });
    row.props.children.at(-1).props.onClick();
    assert.deepEqual(events, ['other', 'close']);
    events.length = 0;
    const followed = PlayerRow({ player: { userId: 'other', isFollowing: true, used: 1, limit: 3 }, onStopFollowing: () => events.push('stop'), onClose: () => events.push('close') });
    followed.props.children.at(-1).props.onClick();
    assert.deepEqual(events, ['stop', 'close']);
  } finally { await server.close(); }
});
