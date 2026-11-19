import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { relayEntrypoint } from '../test-support/relay-entrypoint.js';
import * as config from './relay-config.js';

const response = () => Object.assign(new EventEmitter(), {
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
  end(body) { this.body = body; },
});
const request = url => ({ method: 'GET', url, headers: {} });

test('HTTP dispatch preserves prefixed readiness, liveness, unknown and invalid target responses', async t => {
  const state = await relayEntrypoint(t);
  for (const [url, status, body] of [
    ['/readyz', 200, 'ready'], ['/yjs/readyz', 200, 'ready'],
    ['/', 200, 'yjs-ws ok'], ['/missing', 404, 'not found'],
    [undefined, 400, undefined], ['/'.repeat(config.MAX_HTTP_TARGET_CHARACTERS + 1), 400, undefined],
  ]) {
    const res = response();
    state.dispatch(request(url), res);
    assert.equal(res.status, status, String(url));
    assert.equal(res.body, body);
    res.emit('finish');
    res.emit('close');
  }
  state.lifecycle.onStart('SIGTERM');
  const res = response();
  state.dispatch(request('/readyz'), res);
  assert.equal(res.status, 503);
  assert.equal(res.body, 'not ready');
});

test('HTTP dispatch releases a request slot on finish or close exactly once', async t => {
  const state = await relayEntrypoint(t, { modules: {
    './src/server/relay-config.js': { ...config, readRelayConfig: () => ({
      ...config.readRelayConfig(), MAX_HTTP_REQUESTS: 1, MAX_HTTP_REQUESTS_PER_IP: 1,
    }) },
  } });
  const first = response();
  state.dispatch(request('/'), first);
  const refused = response();
  state.dispatch(request('/'), refused);
  assert.equal(refused.status, 503);
  assert.equal(refused.headers['retry-after'], '2');
  first.emit('finish'); first.emit('close');
  const next = response();
  state.dispatch(request('/'), next);
  assert.equal(next.status, 200);
  next.emit('close');
});
