import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('transfer emits the selected identity and closes; follow emits then closes', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { TransferRow, PlayerRow } = await server.ssrLoadModule('/src/client/chrome/TopBarPopovers.jsx');
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

test('the More menu routes action items, summary and image exports, then closes', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { MorePopover } = await server.ssrLoadModule('/src/client/chrome/TopBarPopovers.jsx');
    const { t } = await server.ssrLoadModule('/src/client/ui/i18n.js');
    const events = [];
    const handler = name => () => events.push(name);
    const exports = { openActionCount: 2, onActionItems: handler('actions'), copySummary: handler('copy'),
      downloadSummary: handler('md'), exportJson: handler('json'), exportCsv: handler('csv'),
      exportPng: handler('png'), exportPdf: handler('pdf') };
    const tree = MorePopover({ isAdmin: true, exports, onClose: handler('close') });
    const items = tree.props.children.filter(child => child?.props?.label);
    const click = label => items.find(item => item.props.label === label).props.onClick();
    for (const key of ['summary.copy', 'summary.download', 'topbar.exportPng', 'topbar.exportPdf']) click(t(key));
    click(t('action.menuCount', { n: 2 }));
    assert.deepEqual(events, ['close', 'copy', 'close', 'md', 'close', 'png', 'close', 'pdf', 'close', 'actions']);
    const busy = MorePopover({ isAdmin: true, exports: { busy: true }, onClose: () => {} }).props.children
      .filter(child => child?.props?.label === t('topbar.exportPng'));
    assert.equal(busy[0].props.disabled, true);
  } finally { await server.close(); }
});
