import test from 'node:test';
import assert from 'node:assert/strict';
import { withSsrModule } from '../../test-support/ssr-load.js';

const SUBJECT = '/src/client/chrome/use-topbar-props.js';
test('topbar props preserve roles, quota, command identities and guarded admin ordering', async () => {
  await withSsrModule(SUBJECT, ({ topBarProps }) => {
    const events = [];
    const actions = Object.fromEntries(['setToast', 'copyRoomLink', 'doUndo', 'doRedo', 'adminToggle', 'adminClaim',
      'setNameDraft', 'setNameModalOpen', 'onImportPick', 'setHelpOpen', 'setConfirmUnlockAll', 'setConfirmResetVotes',
      'setConfirmClear', 'adminTransfer', 'startFollowing', 'stopFollowing'].map(key => [key, (...args) => events.push([key, ...args])]));
    actions.requirePrivateAdminPin = (run) => { events.push(['PIN']); run(); };
    const input = {
      boardState: { board: { title: 'Retro', editingLocked: true, adminUserId: 'owner', adminName: 'Old' }, undoState: { canUndo: true, canRedo: false } },
      session: { mode: 'private', boardCode: 'code', isAdmin: false, canClaim: false, userId: 'me', userName: 'Me' },
      collaboration: { presence: { owner: { name: 'Live' } }, onlineUsers: [{ userId: 'owner', name: 'Live' }],
        followedUserId: 'owner', votesUsedByUser: new Map([['owner', 3]]), activeZoneVoteLimit: 3 },
      appearance: { themePref: 'auto', setThemePref: value => events.push(['theme', value]), scrollWheelZoomEnabled: true, toggleScrollWheelZoom() {} },
      workflow: { presenter: {}, retroPhase: {}, mood: {}, boardExports: { marker: 'export' } }, actions,
    };
    const props = topBarProps(input);
    assert.equal(props.title, 'Retro');
    assert.equal(props.canUndo, true);
    assert.equal(props.canRedo, false);
    assert.equal(props.editingLocked, true);
    assert.deepEqual(props.admin, { name: 'Live', isOnline: true });
    assert.equal(props.players[0].isFollowing, true);
    assert.equal(props.players[0].isFull, true);
    assert.equal(props.players[0].used, 3);
    assert.equal(props.onUndo, actions.doUndo);
    assert.equal(props.onFollow, actions.startFollowing);
    assert.equal(props.exports, input.workflow.boardExports);
    props.onClear();
    assert.equal(events.length, 1);
    assert.equal(events[0][0], 'setToast');
    assert.equal(events[0][1].type, 'warn');
    events.length = 0;
    input.session.isAdmin = true;
    const admin = topBarProps(input);
    admin.onUnlockAll(); admin.onResetVotes(); admin.onClear(); admin.onTransferAdmin('peer'); admin.onEditName();
    assert.deepEqual(events, [['setConfirmUnlockAll', true], ['setConfirmResetVotes', true], ['setConfirmClear', true],
      ['PIN'], ['adminTransfer', 'peer'], ['setNameDraft', 'Me'], ['setNameModalOpen', true]]);
  });
});
