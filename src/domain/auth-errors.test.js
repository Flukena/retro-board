import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_ERROR, AUTH_ERROR_CODES, isAuthErrorCode } from './auth-errors.js';

test('auth error codes are exactly the documented set', () => {
  assert.deepEqual([...AUTH_ERROR_CODES].sort(), [
    'access_denied', 'email_unverified', 'invalid_id_token', 'provider_error', 'state_mismatch', 'token_exchange_failed',
  ]);
  assert.ok(Object.isFrozen(AUTH_ERROR_CODES));
  assert.ok(Object.isFrozen(AUTH_ERROR));
});

test('isAuthErrorCode accepts only listed codes', () => {
  assert.equal(isAuthErrorCode(AUTH_ERROR.ACCESS_DENIED), true);
  for (const code of ['', 'toString', 'constructor', 'STATE_MISMATCH', null, undefined, 1]) {
    assert.equal(isAuthErrorCode(code), false, String(code));
  }
});
