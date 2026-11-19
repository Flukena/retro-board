import test from 'node:test';
import assert from 'node:assert/strict';
import { readAllowedOrigins } from './relay-origins.js';

const URL_ERROR = 'YJS_ALLOWED_ORIGINS must contain exact URL origins';
const HTTPS_ERROR = 'YJS_ALLOWED_ORIGINS must contain exact HTTPS origins (or localhost HTTP in dev mode)';
for (const [value, dev, expected] of [
  [undefined, false, []], ['', true, []], [' , https://example.com ,,https://example.com ', false, ['https://example.com', 'https://example.com']],
  ['https://example.com:8443', false, ['https://example.com:8443']],
  ['http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173', true, ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']],
]) test(`reads exact allowlist ${value} in dev=${dev}`, () => assert.deepEqual(readAllowedOrigins(value, dev), expected));
for (const [value, dev, message] of [
  ['*', false, URL_ERROR], ['not a url', false, URL_ERROR],
  ['https://example.com/', false, HTTPS_ERROR], ['https://example.com/path', false, HTTPS_ERROR],
  ['https://example.com?x=1', false, HTTPS_ERROR], ['https://example.com#hash', false, HTTPS_ERROR],
  ['https://user:pass@example.com', false, HTTPS_ERROR], ['https://example.com:443', false, HTTPS_ERROR],
  ['HTTPS://example.com', false, HTTPS_ERROR], ['http://localhost:5173', false, HTTPS_ERROR],
  ['http://example.com', true, HTTPS_ERROR], ['http://localhost.example.com', true, HTTPS_ERROR],
  ['ftp://example.com', true, HTTPS_ERROR],
]) test(`rejects ${value} with byte-identical startup error`, () => {
  assert.throws(() => readAllowedOrigins(value, dev), { name: 'Error', message });
});
