import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { envInt, envBool, readRelayConfig, syncResponseLimits } from './relay-config.js';

const REPO_URL = new URL('../../', import.meta.url);
const MIN_VALUE = 2;
const MAX_VALUE = 8;
const FALLBACK_VALUE = 4;
const MIB_BYTES = 1_048_576;

test('integer configuration preserves empty fallbacks, safe integers and inclusive bounds', () => {
  const bounds = { min: MIN_VALUE, max: MAX_VALUE };
  assert.equal(envInt('LIMIT', FALLBACK_VALUE, bounds, {}), FALLBACK_VALUE);
  assert.equal(envInt('LIMIT', FALLBACK_VALUE, bounds, { LIMIT: '' }), FALLBACK_VALUE);
  assert.equal(envInt('LIMIT', FALLBACK_VALUE, bounds, { LIMIT: '2' }), MIN_VALUE);
  assert.equal(envInt('LIMIT', FALLBACK_VALUE, bounds, { LIMIT: '8' }), MAX_VALUE);
  for (const LIMIT of ['1', '9', '2.5', 'NaN', 'Infinity', '9007199254740992']) {
    assert.throws(() => envInt('LIMIT', FALLBACK_VALUE, bounds, { LIMIT }),
      { message: 'LIMIT must be an integer between 2 and 8' });
  }
});

test('boolean configuration preserves accepted spellings and exact failure', () => {
  for (const FLAG of ['1', 'true', 'YES']) assert.equal(envBool('FLAG', false, { FLAG }), true);
  for (const FLAG of ['0', 'false', 'NO']) assert.equal(envBool('FLAG', true, { FLAG }), false);
  assert.equal(envBool('FLAG', true, {}), true);
  assert.equal(envBool('FLAG', false, { FLAG: '' }), false);
  assert.throws(() => envBool('FLAG', false, { FLAG: 'on' }),
    { message: 'FLAG must be one of: 1, 0, true, false, yes, no' });
});

test('capacity profile plus Compose overrides retain exact effective production limits', () => {
  const profile = readFileSync(new URL('config/room-capacity.env', REPO_URL), 'utf8');
  const compose = readFileSync(new URL('docker-compose.prod.yml', REPO_URL), 'utf8');
  const env = Object.fromEntries([...profile.matchAll(/^(YJS_[A-Z_]+)=(\d+)$/gm)]
    .map(([, key, value]) => [key, value]));
  for (const [, key, value] of compose.split('  yjs-public:')[0].matchAll(/^      - (YJS_[A-Z_]+)=(\d+)$/gm)) env[key] = value;
  const config = readRelayConfig(env);
  assert.equal(Object.isFrozen(config), true);
  const expected = {
    MAX_CONNECTIONS_PER_ROOM: 32, MAX_CONNECTIONS_PER_IP: 64,
    ROOM_RL_MAX_MSGS: 2048, ROOM_RL_REFILL_MSGS_PER_SEC: 1024,
    GLOBAL_RL_MAX_MSGS: 4096, GLOBAL_RL_REFILL_MSGS_PER_SEC: 2048,
    WS_EGRESS_ROOM_BURST_MESSAGES: 65536, WS_EGRESS_ROOM_MESSAGES_PER_SECOND: 32768,
    WS_EGRESS_GLOBAL_BURST_MESSAGES: 131072, WS_EGRESS_GLOBAL_MESSAGES_PER_SECOND: 65536,
    ROOM_MAX_UNCOMPACTED_UPDATES: 65536,
    MAX_DOCUMENT_BYTES: 33554432, MAX_ACTIVE_DOCUMENT_BYTES: 100663296,
    ROOM_COMPACTION_MIN_INTERVAL_MS: 60000, DOCUMENT_REMEASURE_MIN_INTERVAL_MS: 60000,
    MAX_ROOM_UPLOAD_BYTES: 5368709120, MAX_UPLOAD_STORAGE_BYTES: 8589934592,
    MAX_ROOM_UPLOAD_FILES: 10000, MAX_UPLOAD_FILES: 50000,
    MAX_UPLOAD_BYTES: 5242880, MAX_WS_BUFFERED_BYTES: 41943040,
    MAX_AWARENESS_ROOM_BYTES: 122880,
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(config[name], value, name);
});

test('configuration retains upload default and dependent bounds', () => {
  assert.equal(readRelayConfig({}).MAX_UPLOAD_BYTES, 5 * MIB_BYTES);
  assert.equal(readRelayConfig({ YJS_MAX_UPLOAD_BYTES: '1024' }).MAX_UPLOAD_BYTES, 1024);
  assert.throws(() => readRelayConfig({ YJS_MAX_UPLOAD_BYTES: '1023' }), /YJS_MAX_UPLOAD_BYTES/);
  assert.throws(() => readRelayConfig({ YJS_MAX_UPLOAD_BYTES: '20971521' }), /YJS_MAX_UPLOAD_BYTES/);
  assert.throws(() => readRelayConfig({ YJS_MAX_DOCUMENT_BYTES: '67108864', YJS_MAX_ACTIVE_DOCUMENT_BYTES: '33554432' }), /YJS_MAX_ACTIVE_DOCUMENT_BYTES/);
  assert.throws(() => readRelayConfig({ YJS_MAX_AWARENESS_MESSAGE_BYTES: '1024' }), /too small for the configured awareness/);
});

test('importing configuration does not evaluate environment limits', async () => {
  const name = 'YJS_MAX_UPLOAD_BYTES';
  const previous = process.env[name];
  process.env[name] = 'invalid-integer-for-import-test';
  try {
    const imported = await import('./relay-config.js?import-only-contract');
    assert.equal(typeof imported.readRelayConfig, 'function');
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});


test('Public500 profile leaves private admission unchanged and preserves bounded transport budgets', () => {
  const base = readFileSync(new URL('config/room-capacity.env', REPO_URL), 'utf8');
  const publicProfile = readFileSync(new URL('config/public-room-capacity.env', REPO_URL), 'utf8');
  const env = Object.fromEntries([...(base + '\n' + publicProfile).matchAll(/^(YJS_[A-Z_]+)=(\d+)$/gm)]
    .map(([, key, value]) => [key, value]));
  const config = readRelayConfig(env);
  assert.equal(config.MAX_CONNECTIONS_PER_ROOM, 500);
  assert.equal(config.MAX_CONNECTIONS_PER_IP, 500);
  assert.equal(config.SYNC_RESPONSE_ROOM_BURST_MESSAGES, 512);
  assert.equal(config.SYNC_RESPONSES_PER_ROOM_PER_SECOND, 32);
  assert.equal(config.WS_EGRESS_ROOM_MESSAGES_PER_SECOND, 131072);
  assert.equal(config.WS_EGRESS_ROOM_BYTES_PER_SECOND, 32 * MIB_BYTES);
  const defaults = readRelayConfig({});
  assert.equal(config.RL_MAX_MSGS, defaults.RL_MAX_MSGS);
  assert.equal(config.MAX_DOCUMENT_BYTES, defaults.MAX_DOCUMENT_BYTES);
  assert.equal(config.MAX_PENDING_STORE_BYTES, defaults.MAX_PENDING_STORE_BYTES);
  assert.equal(defaults.SYNC_RESPONSE_ROOM_BURST_MESSAGES, 32);
  assert.equal(defaults.SYNC_RESPONSES_PER_ROOM_PER_SECOND, 8);
});


test('sync response limits preserve private defaults when assembled outside the entry point', () => {
  const limits = syncResponseLimits(readRelayConfig({}));
  assert.equal(limits.connection.messagesPerSecond, 0.1);
  assert.equal(limits.room.maxMessages, 32);
  assert.equal(limits.room.messagesPerSecond, 8);
  assert.equal(limits.global.maxMessages, 128);
  assert.equal(limits.global.messagesPerSecond, 32);
});
