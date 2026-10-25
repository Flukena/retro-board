import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { confirmThenPin } from './confirm-then-pin.js';

const source = readFileSync(new URL('../../../RetroBoard.jsx', import.meta.url), 'utf8');
const actions = ['UnlockAll', 'ResetVotes', 'ClearBoard'];
for (const action of actions) {
  test(`${action}: confirm closes before PIN and stays closed after cancel`, async () => {
    let confirm = true;
    let pin = false;
    let calls = 0;
    const setter = action === 'ClearBoard' ? 'setConfirmClear' : `setConfirm${action}`;
    const expression = source.match(new RegExp(`onConfirm=\\{(\\(\\) => [^\\n]+admin${action}[^\\n]+)\\}`))[1];
    const requirePin = () => { pin = true; assert.equal(confirm, false, 'confirm must be gone when PIN opens'); };
    const [, callee, argumentsText] = expression.match(/^\(\) => (\w+)\(([\w,\s]+)\)$/);
    const bindings = {
      [setter]: () => { confirm = false; }, requireAdminPin: requirePin,
      [`admin${action}`]: () => { calls += 1; }, confirmThenPin,
    };
    bindings[callee](...argumentsText.split(',').map((name) => bindings[name.trim()]));
    assert.equal(pin, true);
    pin = false;
    assert.equal(confirm, false);
    assert.equal(calls, 0);
  });
}

test('cached PIN executes synchronously after close; wrong, denied and failed writes cannot reopen confirm', async () => {
  for (const outcome of ['cached', 'wrong', 'denied', 'write-failure']) {
    let confirm = true;
    let calls = 0;
    const action = () => { calls += 1; return false; };
    confirmThenPin(() => { confirm = false; }, (run) => {
      assert.equal(confirm, false);
      if (outcome === 'cached' || outcome === 'write-failure') run();
    }, action);
    assert.equal(confirm, false);
    assert.equal(calls, outcome === 'cached' || outcome === 'write-failure' ? 1 : 0);
  }
});
