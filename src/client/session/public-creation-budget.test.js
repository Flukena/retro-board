import test from 'node:test';
import assert from 'node:assert/strict';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { PUBLIC_QUOTA_MESSAGE_TYPE } from '../../domain/public-wall-contract.js';
import { attachPublicCreationBudget } from './public-creation-budget.js';

test('only socket quota messages reach the Public guard', () => {
  const provider = { messageHandlers: [] };
  const received = [];
  attachPublicCreationBudget(provider, { applyBudget: value => received.push(value) });
  const value = { entries: [], acceptedIds: [] };
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, JSON.stringify(value));
  const payload = encoding.toUint8Array(encoder);
  const handler = provider.messageHandlers[PUBLIC_QUOTA_MESSAGE_TYPE];
  handler(null, decoding.createDecoder(payload), provider, false);
  assert.deepEqual(received, []);
  handler(null, decoding.createDecoder(payload), provider, true);
  assert.deepEqual(received, [value]);
});

test('malformed quota messages do not change the guard', () => {
  const provider = { messageHandlers: [] };
  let calls = 0;
  attachPublicCreationBudget(provider, { applyBudget: () => { calls += 1; } });
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, '{');
  provider.messageHandlers[PUBLIC_QUOTA_MESSAGE_TYPE](null, decoding.createDecoder(encoding.toUint8Array(encoder)), provider, true);
  assert.equal(calls, 0);
});
