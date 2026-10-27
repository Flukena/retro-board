import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaintainerSessions, MAINTAINER_SESSION_SECONDS } from './maintainer-session.js';

const cookiePair = header => header.split(';')[0];

test('sessions expire after thirty days and are isolated between relay keys and restarts', () => {
  let now = 0;
  const sessions = createMaintainerSessions('private-key', () => now);
  const cookie = cookiePair(sessions.issue('', true));
  assert.equal(sessions.valid(cookie), true);
  assert.equal(createMaintainerSessions('public-key').valid(cookie), false);
  assert.equal(createMaintainerSessions('private-key').valid(cookie), false);
  now = MAINTAINER_SESSION_SECONDS * 1000;
  assert.equal(sessions.valid(cookie), false);
});

test('session cookies are secure on HTTPS and renewing or logging out revokes the old token', () => {
  const sessions = createMaintainerSessions('key');
  const issued = sessions.issue('', true);
  assert.match(issued, /; Secure$/);
  const old = cookiePair(issued);
  const fresh = cookiePair(sessions.issue(old, false));
  assert.equal(sessions.valid(old), false);
  assert.equal(sessions.valid(fresh), true);
  sessions.revoke(fresh, false);
  assert.equal(sessions.valid(fresh), false);
});

test('session storage evicts the oldest session at its bounded capacity', () => {
  const sessions = createMaintainerSessions('key');
  const oldest = cookiePair(sessions.issue('', false));
  let newest;
  for (let index = 0; index < 32; index += 1) newest = cookiePair(sessions.issue('', false));
  assert.equal(sessions.valid(oldest), false);
  assert.equal(sessions.valid(newest), true);
});
