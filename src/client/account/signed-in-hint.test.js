import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNT_STATUS } from './account-api.js';
import {
  forgetSignedIn, readSignedInHint, rememberSignedIn, SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE,
  syncSignedInHint,
} from './signed-in-hint.js';
import { mapStorage } from './map-storage.fixture.js';

const throwingStorage = () => {
  const fail = () => { throw new Error('storage blocked'); };
  return { getItem: fail, setItem: fail, removeItem: fail };
};

test('the hint is the exact key and value task 7 reads in the head script', () => {
  assert.equal(SIGNED_IN_HINT_KEY, 'rb_signed_in');
  assert.equal(SIGNED_IN_HINT_VALUE, '1');
});

test('remember, read and forget round-trip', () => {
  const storage = mapStorage();
  assert.equal(readSignedInHint(storage), false);
  rememberSignedIn(storage);
  assert.equal(readSignedInHint(storage), true);
  forgetSignedIn(storage);
  assert.equal(readSignedInHint(storage), false);
});

test('any other stored value is not a signed-in hint', () => {
  const storage = mapStorage(new Map([[SIGNED_IN_HINT_KEY, 'true']]));
  assert.equal(readSignedInHint(storage), false);
});

test('sync remembers signed-in, forgets signed-out and disabled, and keeps unavailable as is', () => {
  const map = new Map();
  const storage = mapStorage(map);
  syncSignedInHint({ status: ACCOUNT_STATUS.SIGNED_IN }, storage);
  assert.deepEqual([...map.entries()], [['rb_signed_in', '1']]);
  syncSignedInHint({ status: ACCOUNT_STATUS.UNAVAILABLE }, storage);
  assert.equal(readSignedInHint(storage), true);
  syncSignedInHint({ status: ACCOUNT_STATUS.SIGNED_OUT }, storage);
  assert.equal(readSignedInHint(storage), false);
  rememberSignedIn(storage);
  syncSignedInHint({ status: ACCOUNT_STATUS.DISABLED }, storage);
  assert.equal(readSignedInHint(storage), false);
  syncSignedInHint({ status: ACCOUNT_STATUS.UNAVAILABLE }, storage);
  assert.equal(readSignedInHint(storage), false);
});

test('missing or throwing storage reads false and never throws', () => {
  for (const storage of [undefined, null, throwingStorage()]) {
    assert.equal(readSignedInHint(storage), false);
    assert.doesNotThrow(() => {
      rememberSignedIn(storage);
      forgetSignedIn(storage);
      syncSignedInHint({ status: ACCOUNT_STATUS.SIGNED_IN }, storage);
    });
  }
});
