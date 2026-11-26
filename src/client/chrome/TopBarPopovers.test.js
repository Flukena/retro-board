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

test('the More menu offers board exports and omits the retired action and summary commands', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { MorePopover } = await server.ssrLoadModule('/src/client/chrome/TopBarPopovers.jsx');
    const { t, setLang } = await server.ssrLoadModule('/src/client/ui/i18n.js');
    await setLang('en');
    const events = [];
    const handler = name => () => events.push(name);
    const exports = { exportJson: handler('json'), exportCsv: handler('csv'), exportPng: handler('png'), exportPdf: handler('pdf') };
    const tree = MorePopover({ isAdmin: true, exports, onClose: handler('close') });
    const items = tree.props.children.filter(child => child?.props?.label);
    const labels = items.map(item => item.props.label);
    for (const retired of ['Action items', 'Copy retro summary', 'Download summary (.md)']) {
      assert.ok(!labels.includes(retired), retired);
    }
    for (const key of ['topbar.export', 'topbar.exportCsv', 'topbar.exportPng', 'topbar.exportPdf']) {
      items.find(item => item.props.label === t(key)).props.onClick();
    }
    assert.deepEqual(events, ['close', 'json', 'close', 'csv', 'close', 'png', 'close', 'pdf']);
    const busy = MorePopover({ isAdmin: true, exports: { busy: true }, onClose: () => {} }).props.children
      .filter(child => child?.props?.label === t('topbar.exportPng'));
    assert.equal(busy[0].props.disabled, true);
  } finally { await server.close(); }
});

test('presenter menu: admins start, the presenter stops, public rooms hide it', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { MorePopover } = await server.ssrLoadModule('/src/client/chrome/TopBarPopovers.jsx');
    const { t } = await server.ssrLoadModule('/src/client/ui/i18n.js');
    const events = [];
    const presenter = { available: true, presenting: false, startPresenting: () => events.push('start'), stopPresenting: () => events.push('stop') };
    const find = (props, label) => MorePopover({ onClose: () => {}, ...props }).props.children.find(child => child?.props?.label === label);
    find({ isAdmin: true, presenter }, t('presenter.start')).props.onClick();
    assert.equal(find({ isAdmin: false, presenter }, t('presenter.start')).props.disabled, true);
    const stop = find({ isAdmin: false, presenter: { ...presenter, presenting: true } }, t('presenter.stop'));
    assert.equal(stop.props.disabled, false);
    stop.props.onClick();
    assert.deepEqual(events, ['start', 'stop']);
    assert.equal(find({ isAdmin: true, presenter: { ...presenter, available: false } }, t('presenter.start')), undefined);
  } finally { await server.close(); }
});

test('meeting phase menu: only admins start or end phases, public rooms hide it', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { MorePopover } = await server.ssrLoadModule('/src/client/chrome/TopBarPopovers.jsx');
    const { t } = await server.ssrLoadModule('/src/client/ui/i18n.js');
    const events = [];
    const phase = { available: true, running: false, start: () => events.push('start'), end: () => events.push('end') };
    const find = (props, label) => MorePopover({ onClose: () => {}, ...props }).props.children.find(child => child?.props?.label === label);
    find({ isAdmin: true, phase }, t('phase.start')).props.onClick();
    find({ isAdmin: true, phase: { ...phase, running: true } }, t('phase.stop')).props.onClick();
    assert.deepEqual(events, ['start', 'end']);
    assert.equal(find({ isAdmin: false, phase }, t('phase.start')).props.disabled, true);
    assert.equal(find({ isAdmin: true, phase: { ...phase, available: false } }, t('phase.start')), undefined);
  } finally { await server.close(); }
});

test('mood check menu: only admins open or close a round, public rooms hide it', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { MorePopover } = await server.ssrLoadModule('/src/client/chrome/TopBarPopovers.jsx');
    const { t } = await server.ssrLoadModule('/src/client/ui/i18n.js');
    const events = [];
    const mood = { available: true, open: false, start: () => events.push('start'), close: () => events.push('close') };
    const find = (props, label) => MorePopover({ onClose: () => {}, ...props }).props.children.find(child => child?.props?.label === label);
    find({ isAdmin: true, mood }, t('mood.start')).props.onClick();
    find({ isAdmin: true, mood: { ...mood, open: true } }, t('mood.close')).props.onClick();
    assert.deepEqual(events, ['start', 'close']);
    assert.equal(find({ isAdmin: false, mood }, t('mood.start')).props.disabled, true);
    assert.equal(find({ isAdmin: true, mood: { ...mood, available: false } }, t('mood.start')), undefined);
    const show = { ...mood, canShowResult: true, showResult: () => events.push('show') };
    find({ isAdmin: true, mood: show }, t('mood.showResult')).props.onClick();
    assert.equal(events.at(-1), 'show');
    assert.equal(find({ isAdmin: true, mood }, t('mood.showResult')), undefined);
    assert.equal(find({ isAdmin: true, mood: { ...show, available: false } }, t('mood.showResult')), undefined);
  } finally { await server.close(); }
});
