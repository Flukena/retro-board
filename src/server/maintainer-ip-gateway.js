import { createServer, request } from 'node:http';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_HEADER_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 16;
const TAILNET_SECOND_OCTET_MIN = 64;
const TAILNET_SECOND_OCTET_MAX = 127;
const PORT_MAX = 65535;
const READ_METHODS = new Set(['GET', 'HEAD']);
const PATH_RE = /^(?:\/|\/maintainer\.(?:js|css)|\/api\/(?:status|session|rooms\/[A-Za-z0-9_-]{32}\/join))$/;
const FORWARDED_HEADERS = ['authorization', 'cookie', 'sec-fetch-site', 'accept', 'accept-encoding'];
const UNIQUE_HEADERS = ['host', 'origin', 'authorization', 'cookie'];

function gatewayOrigin(value) {
  const origin = new URL(value);
  const [firstOctet, secondOctet] = origin.hostname.split('.').map(Number);
  const tailnet = isIP(origin.hostname) === 4 && firstOctet === 100
    && secondOctet >= TAILNET_SECOND_OCTET_MIN && secondOctet <= TAILNET_SECOND_OCTET_MAX;
  if (!tailnet || origin.protocol !== 'http:' || origin.origin !== value) throw new Error('Expected an exact HTTP Tailscale IPv4 origin');
  return origin;
}

function allowedRequest(req, origin) {
  const local = req.socket.remoteAddress === LOOPBACK_HOST || req.socket.remoteAddress === '::ffff:127.0.0.1';
  const unique = UNIQUE_HEADERS.every(name => (req.headersDistinct[name]?.length ?? 0) <= 1);
  const sameOrigin = req.headers.origin === origin.origin;
  return local && unique && req.headers.host === origin.host
    && req.headers['sec-fetch-site'] !== 'cross-site'
    && (sameOrigin || (!req.headers.origin && READ_METHODS.has(req.method)));
}

function reject(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-length': '0', connection: 'close' });
  res.end();
}

function forwardRequest(req, res, upstreamPort) {
  const host = `${LOOPBACK_HOST}:${upstreamPort}`;
  const headers = Object.fromEntries(FORWARDED_HEADERS.filter(name => req.headers[name] !== undefined)
    .map(name => [name, req.headers[name]]));
  headers.host = host;
  if (req.headers.origin) headers.origin = `http://${host}`;
  const upstream = request({ host: LOOPBACK_HOST, port: upstreamPort, path: req.url, method: req.method, headers,
    agent: false, timeout: REQUEST_TIMEOUT_MS }, response => {
    res.writeHead(response.statusCode, { ...response.headers, 'cache-control': 'no-store' });
    pipeline(response, res, () => {});
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Maintainer upstream timed out')));
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else reject(res, 502);
  });
  res.once('close', () => upstream.destroy());
  upstream.end();
}

// Only a tailnet TCP forwarder reaches this loopback listener. Validate the
// browser's original Host/Origin BEFORE translating to the local console origin.
export function createMaintainerIpGateway({ externalOrigin, upstreamPort }) {
  const origin = gatewayOrigin(externalOrigin);
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > PORT_MAX) throw new Error('Invalid upstream port');
  const server = createServer({maxHeaderSize: MAX_HEADER_BYTES}, (req, res) => {
    if (!allowedRequest(req, origin)) { reject(res, 403); return; }
    if (!PATH_RE.test(req.url)) { reject(res, 404); return; }
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) { reject(res, 413); return; }
    forwardRequest(req, res, upstreamPort);
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.timeout = REQUEST_TIMEOUT_MS;
  return server;
}
