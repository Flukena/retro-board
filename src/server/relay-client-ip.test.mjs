import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIp, clientIpFromRequest } from './relay-client-ip.js';

for (const [value, expected] of [
  [' 192.0.2.1 ', '192.0.2.1'], ['::ffff:192.0.2.1', '192.0.2.1'], ['::1', '::1'],
  ['2001:db8::1', '2001:db8::1'], ['::ffff:invalid', null], ['hostname', null], ['', null], [undefined, null], [42, null],
]) test(`normalizes ${value}`, () => assert.equal(normalizeIp(value), expected));
const request = headers => ({ socket: { remoteAddress: '::ffff:192.0.2.1' }, headers });
for (const [label, headers, trusted, expected] of [
  ['untrusted headers ignored', { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.1' }, false, '192.0.2.1'],
  ['CF preferred over XFF', { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.1' }, true, '198.51.100.1'],
  ['CF array first', { 'cf-connecting-ip': ['198.51.100.1', '203.0.113.1'] }, true, '198.51.100.1'],
  ['invalid CF falls back to first XFF', { 'cf-connecting-ip': 'bad', 'x-forwarded-for': '203.0.113.1, 198.51.100.1' }, true, '203.0.113.1'],
  ['XFF array first', { 'x-forwarded-for': ['203.0.113.1, 198.51.100.1', '192.0.2.2'] }, true, '203.0.113.1'],
  ['invalid first XFF does not trust later entries', { 'x-forwarded-for': 'bad, 203.0.113.1' }, true, '192.0.2.1'],
  ['no proxy headers uses socket', {}, true, '192.0.2.1'],
]) test(label, () => assert.equal(clientIpFromRequest(request(headers), trusted), expected));
test('missing or invalid socket is unknown', () => {
  assert.equal(clientIpFromRequest({ headers: {} }), 'unknown');
  assert.equal(clientIpFromRequest({ headers: {}, socket: { remoteAddress: 'bad' } }, true), 'unknown');
});
