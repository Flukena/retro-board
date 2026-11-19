import { CORS_PREFLIGHT_MAX_AGE_SECONDS } from './relay-config.js';

export const isExactAllowedOrigin = (origin, allowedOrigins, allowInsecureHttp) => {
  if (!origin) return false;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  return allowInsecureHttp
    && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(origin);
};

export const setCredentialCors = (origin, res) => {
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-expose-headers', 'Retry-After');
  res.setHeader('vary', 'Origin');
};

const validateJsonHeaders = (req) => {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw Object.assign(new Error('unsupported content type'), { code: 'BAD_JSON' });
};

/** Buffers a request body, refusing (BODY_TOO_LARGE) as soon as the declared or streamed size passes the cap. */
const readBoundedBody = async (req, maxBodyBytes) => {
  const rawLength = req.headers['content-length'];
  if (rawLength != null && (!/^\d+$/.test(String(rawLength)) || Number(rawLength) > maxBodyBytes)) {
    throw Object.assign(new Error('invalid body length'), { code: 'BODY_TOO_LARGE' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > maxBodyBytes) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

export const readJsonBody = async (req, maxBodyBytes, { allowEmpty = false } = {}) => {
  validateJsonHeaders(req);
  const body = await readBoundedBody(req, maxBodyBytes);
  if (body.length === 0 && allowEmpty) return {};
  let value;
  try { value = JSON.parse(body.toString('utf8')); }
  catch { throw Object.assign(new Error('invalid json'), { code: 'BAD_JSON' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('invalid json'), { code: 'BAD_JSON' });
  return value;
};

export const sendSerializedJson = (res, status, body, extraHeaders = {}) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
};

export const sendJson = (res, status, value, extraHeaders = {}) => (
  sendSerializedJson(res, status, JSON.stringify(value), extraHeaders)
);

export const sendIfWritable = (res, status, headers = {}) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, headers);
  res.end();
};

const UPGRADE_REASONS = new Map([
  [400, 'Bad Request'], [401, 'Unauthorized'], [403, 'Forbidden'],
  [404, 'Not Found'], [431, 'Request Header Fields Too Large'], [429, 'Too Many Requests'],
]);
export const sendUpgradeRejection = (socket, status) => {
  const reason = UPGRADE_REASONS.get(status) || 'Service Unavailable';
  try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
  catch { socket.destroy(); }
};

export const acceptCredentialOrigin = (req, res, allowedOrigins, allowInsecureHttp) => {
  const origin = req.headers.origin || '';
  if (!isExactAllowedOrigin(origin, allowedOrigins, allowInsecureHttp)) {
    res.writeHead(403);
    res.end();
    return false;
  }
  setCredentialCors(origin, res);
  return true;
};

const DEFAULT_PREFLIGHT_HEADERS = 'Content-Type';

export const sendCredentialPreflight = (req, res, { allowedOrigins, allowInsecureHttp, methods, headers = DEFAULT_PREFLIGHT_HEADERS }) => {
  if (!acceptCredentialOrigin(req, res, allowedOrigins, allowInsecureHttp)) return;
  res.writeHead(204, {
    'access-control-allow-methods': methods,
    'access-control-allow-headers': headers,
    'access-control-max-age': String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
    'cache-control': 'no-store',
  });
  res.end();
};
