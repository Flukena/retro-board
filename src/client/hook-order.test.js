import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const LOADING_RETURN = 'if (!loaded) return <BoardLoading />;';
const HOOK_CALL = /\buse[A-Z]\w*\s*\(/;
// Expand only new batch-B wrappers; the fixture records the unmoved hook sequence.
const WRAPPERS = new Map([
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
  return source.split('\n').filter(line => /^  (?:const |use[A-Z])/.test(line))
    .flatMap(line => [...line.matchAll(new RegExp(HOOK_CALL, 'g'))].flatMap(match => {
      const hook = match[0].replace(/\s*\($/, '');
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

test('batch B preserves the captured coordinator hook sequence and wrapper hook order', () => {
  const source = readFileSync(new URL('RetroBoard.jsx', ROOT), 'utf8');
  const baseline = JSON.parse(readFileSync(new URL('src/test-support/p5b-hook-order.json', ROOT), 'utf8'));
  assert.deepEqual(coordinatorHooks(source), baseline);
  for (const [name, [file, expected]] of WRAPPERS) {
    const module = readFileSync(new URL(`src/client/${file}`, ROOT), 'utf8');
    assert.deepEqual(wrapperHooks(module, name), expected, `${name} primitive hook order`);
  }
});
