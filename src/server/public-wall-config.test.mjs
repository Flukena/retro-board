import test from 'node:test';
import assert from 'node:assert/strict';

test('public configuration isolates storage and sets public admission and database defaults', async () => {
  const { publicRelayEnvironment, PUBLIC_WRITER_CAP, PUBLIC_MAX_ITEMS, PUBLIC_SNAPSHOT_INTERVAL_MS } = await import('./public-wall-config.js');
  assert.equal(PUBLIC_WRITER_CAP, 500);
  assert.equal(PUBLIC_MAX_ITEMS, 1500);
  assert.equal(PUBLIC_SNAPSHOT_INTERVAL_MS, 10000);
  assert.throws(() => publicRelayEnvironment({ YJS_PUBLIC_WALL: 'true' }), /directory/);
  assert.throws(() => publicRelayEnvironment({ YJS_PUBLIC_WALL: 'true', YJS_DB_DIR: './yjs-db' }), /directory/);
  const env = publicRelayEnvironment({ YJS_PUBLIC_WALL: 'true', YJS_DB_DIR: '/data/public', YJS_MAX_CONNECTIONS_PER_ROOM: '100' });
  assert.equal(env.YJS_MAX_CONNECTIONS_PER_ROOM, '500');
  assert.equal(env.YJS_MAX_REGISTERED_ROOMS, '1');
  assert.equal(env.YJS_MAX_DB_BYTES, '268435456');
  assert.equal(env.YJS_ALLOW_LEGACY_URL_TOKENS, 'false');
  assert.equal(env.YJS_UPLOADS_DIR, '/data/public-uploads');
  assert.deepEqual(publicRelayEnvironment({ YJS_PORT: '1234' }), { YJS_PORT: '1234' });
});

test('public upload storage is isolated from its database and private default uploads', async () => {
  const { publicRelayEnvironment } = await import('./public-wall-config.js');
  const env = { YJS_PUBLIC_WALL: 'true', YJS_DB_DIR: '/data/public' };
  assert.equal(publicRelayEnvironment({ ...env, YJS_UPLOADS_DIR: '/data/public-images' }).YJS_UPLOADS_DIR, '/data/public-images');
  for (const uploads of ['/data/public', '/data/public/images', '/data', './uploads']) {
    assert.throws(() => publicRelayEnvironment({ ...env, YJS_UPLOADS_DIR: uploads }), /upload.*isolat/i);
  }
});
