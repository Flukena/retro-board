import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const LOADING_RETURN = 'if (!loaded) return <BoardLoading />;';
// Production presence owner replaced these refs/callbacks without moving effects.
const BASE_PRESENCE_REF_COUNT = 7;
const BASE_PRESENCE_CALLBACK_COUNT = 5;
// Base 83a7892 cursor/view channels had seven refs and five callbacks.
const LEGACY_PRESENCE_REF_COUNT = 7;
const LEGACY_PRESENCE_CALLBACK_COUNT = 5;
const HOOK_CALL = /\buse[A-Z]\w*\s*\(/;
// Compare against production 83a7892, expanding extracted owners at their original seams.
const WRAPPERS = new Map([
  ['useToast', ['ui/use-toast.js', ['useState', 'useCallback', 'useEffect']]],
  ['useEditingPresenceState', ['session/use-editing-presence.js', ['useState', 'useState']]],
  ['useEditingPresence', ['session/use-editing-presence.js', ['useEffect', 'useEffect', 'useEffect']]],
  ['usePresenceBroadcastState', ['session/use-presence-broadcast.js', ['useRef']]],
  ['usePresenceBroadcast', ['session/use-presence-broadcast.js', ['useCallback', 'useCallback', 'useCallback']]],
  ['useBrowserZoomGuard', ['board/use-browser-zoom-guard.js', ['useEffect']]],
  ['useFinalizeVotingSession', ['board/use-admin-actions.js', ['useCallback']]],
  ['useBoardShortcuts', ['board/use-board-shortcuts.js', ['useEffect']]],
  ['useOnImportPick', ['transfer/use-board-import.js', ['useCallback']]],
  ['useOnImportFileChange', ['transfer/use-board-import.js', ['useCallback']]],
  ['useConfirmImport', ['transfer/use-board-import.js', ['useCallback']]],
  ['useImageImport', ['transfer/use-image-import.js', ['useCallback']]],
  ['useSelection', ['board/use-selection.js', ['useState', 'useRef', 'useEffect']]],
  ['useFocusedSelection', ['board/use-selection.js', ['useRef', 'useCallback']]],
  ['useSingleSelection', ['board/use-selection.js', ['useCallback']]],
  ['useVoteSnapshotsState', ['board/use-vote-state.js', ['useState', 'useState']]],
  ['useVoteFlashes', ['board/use-vote-state.js', ['useState', 'useCallback']]],
  ['useToggleVote', ['board/use-vote-state.js', ['useCallback']]],
  ['useRemoveItem', ['board/use-vote-state.js', ['useCallback']]],
  ['useAdminToggle', ['board/use-admin-actions.js', ['useCallback']]],
  ['useAdminStartTimer', ['board/use-admin-actions.js', ['useCallback']]],
  ['useAdminExtendTimer', ['board/use-admin-actions.js', ['useCallback']]],
  ['useAdminStopTimer', ['board/use-admin-actions.js', ['useCallback']]],
  ['useAdminClearBoard', ['board/use-admin-actions.js', ['useCallback']]],
  ['useAdminResetVotes', ['board/use-admin-actions.js', ['useCallback']]],
  ['useAdminUnlockAll', ['board/use-admin-actions.js', ['useCallback']]],
  ['useMinimapReveal', ['board/use-minimap.js', ['useCallback']]],
  ['useMinimapNavigation', ['board/use-minimap.js', ['useCallback']]],
  ['useMinimapKeys', ['board/use-minimap.js', ['useCallback']]],
]);

function assertHooksBeforeLoadingReturn(source) {
  const boundary = source.indexOf(LOADING_RETURN);
  assert.notEqual(boundary, -1, 'loading return must remain identifiable');
  assert.doesNotMatch(source.slice(boundary + LOADING_RETURN.length), HOOK_CALL, 'hooks must precede the loading return');
}

function coordinatorHooks(source) {
  return source.split('\n').filter(line => /^(?:  \S|    [^{}]*} = use)/.test(line))
    .flatMap(line => [...line.matchAll(new RegExp(HOOK_CALL, 'g'))].flatMap(match => {
      const hook = match[0].replace(/\s*\($/, '');
      // Toast's independent dismiss effect moved to its state owner in P2.
      if (hook === 'useToast') return ['useState', 'useCallback'];
      // Presence encapsulates seven former refs and two internal flush callbacks.
      if (hook === 'usePresenceBroadcastState') return Array(BASE_PRESENCE_REF_COUNT).fill('useRef');
      if (hook === 'usePresenceBroadcast') return Array(BASE_PRESENCE_CALLBACK_COUNT).fill('useCallback');
      return WRAPPERS.get(hook)?.[1] || [hook];
    }));
}

function wrapperHooks(source, name) {
  const signature = `export function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start + signature.length);
  const nextExport = source.indexOf('\nexport ', bodyStart);
  const body = source.slice(bodyStart, nextExport < 0 ? source.length : nextExport);
  return [...body.matchAll(new RegExp(HOOK_CALL, 'g'))].map(match => match[0].replace(/\s*\($/, ''));
}

test('RetroBoard calls every hook before its loading return', () => {
  assertHooksBeforeLoadingReturn(readFileSync(new URL('RetroBoard.jsx', ROOT), 'utf8'));
});

test('hook-order guard rejects an added hook after the loading return', () => {
  const source = `function Board() { useState(null); ${LOADING_RETURN}\n useEffect(() => {}, []); return null; }`;
  assert.throws(() => assertHooksBeforeLoadingReturn(source), /hooks must precede/);
});

test('coordinator preserves production-base hook order with the accepted independent toast move', () => {
  const source = readFileSync(new URL('RetroBoard.jsx', ROOT), 'utf8');
  const baseline = JSON.parse(readFileSync(new URL('src/test-support/p5b-hook-order.json', ROOT), 'utf8'));
  assert.equal(baseline.capturedFrom, '83a7892:RetroBoard.jsx');
  const expected = baseline.hooks.filter((_hook, index) => index !== baseline.acceptedToastDismissMove);
  assert.deepEqual(coordinatorHooks(source), expected);
  for (const [name, [file, wrapperExpected]] of WRAPPERS) {
    const module = readFileSync(new URL(`src/client/${file}`, ROOT), 'utf8');
    assert.deepEqual(wrapperHooks(module, name), wrapperExpected, `${name} primitive hook order`);
  }
});

test('multiline identity/template/admin hooks are covered and reordering any one is rejected', () => {
  const source = readFileSync(new URL('RetroBoard.jsx', ROOT), 'utf8');
  const expected = coordinatorHooks(source);
  for (const name of ['useUserIdentity', 'useBoardTemplates', 'useAdminRole']) {
    assert.ok(expected.includes(name), `${name} must be tracked`);
    const removed = source.replace(`${name}(`, 'readValue(');
    assert.throws(() => assert.deepEqual(coordinatorHooks(removed), expected), assert.AssertionError);
    const reordered = `${removed}\n  ${name}();`;
    assert.throws(() => assert.deepEqual(coordinatorHooks(reordered), expected), assert.AssertionError);
  }
});
