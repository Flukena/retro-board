import test from 'node:test';
import assert from 'node:assert/strict';
import { prefillNameDraft } from './name-prefill.js';
import { ACCOUNT_STATUS } from '../account/account-api.js';
import { DISPLAY_NAME_MAX_LENGTH } from '../../domain/security-boundaries.js';

const PLACEHOLDER = 'Guest-4321';
const signedIn = (name) => ({ status: ACCOUNT_STATUS.SIGNED_IN, account: { name, plan: 'free' } });

test('a signed-in account name replaces the untouched guest placeholder', () => {
  assert.equal(prefillNameDraft(PLACEHOLDER, PLACEHOLDER, signedIn('Ada Lovelace')), 'Ada Lovelace');
});

test('the account name is trimmed and capped like any display name', () => {
  assert.equal(prefillNameDraft(PLACEHOLDER, PLACEHOLDER, signedIn('  Ada  ')), 'Ada');
  const long = 'A'.repeat(DISPLAY_NAME_MAX_LENGTH + 5);
  assert.equal(prefillNameDraft(PLACEHOLDER, PLACEHOLDER, signedIn(long)).length, DISPLAY_NAME_MAX_LENGTH);
});

test('text the user already typed is never overwritten', () => {
  assert.equal(prefillNameDraft('Bob', PLACEHOLDER, signedIn('Ada')), 'Bob');
  assert.equal(prefillNameDraft('', PLACEHOLDER, signedIn('Ada')), '', 'a cleared field stays cleared');
});

test('nothing changes once the placeholder is gone (name saved or dialog closed)', () => {
  assert.equal(prefillNameDraft(PLACEHOLDER, null, signedIn('Ada')), PLACEHOLDER);
});

test('guests, disabled sign-in, an unavailable relay and an empty Google name keep the placeholder', () => {
  for (const result of [
    { status: ACCOUNT_STATUS.SIGNED_OUT },
    { status: ACCOUNT_STATUS.DISABLED },
    { status: ACCOUNT_STATUS.UNAVAILABLE },
    signedIn(''),
    signedIn('   '),
  ]) {
    assert.equal(prefillNameDraft(PLACEHOLDER, PLACEHOLDER, result), PLACEHOLDER, JSON.stringify(result));
  }
});
