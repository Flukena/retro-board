import { isIP } from 'node:net';
const IPV4_MAPPED_PREFIX = '::ffff:';
const IPV4_VERSION = 4;

export const normalizeIp = (value) => {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.startsWith(IPV4_MAPPED_PREFIX) && isIP(candidate.slice(IPV4_MAPPED_PREFIX.length)) === IPV4_VERSION) candidate = candidate.slice(IPV4_MAPPED_PREFIX.length);
  return isIP(candidate) ? candidate : null;
};

export const clientIpFromRequest = (req, trustProxy = false) => {
  const socketIp = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  if (!trustProxy) return socketIp;
  const cfIp = normalizeIp(Array.isArray(req.headers['cf-connecting-ip'])
    ? req.headers['cf-connecting-ip'][0]
    : req.headers['cf-connecting-ip']);
  if (cfIp) return cfIp;
  const forwarded = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'];
  return normalizeIp(typeof forwarded === 'string' ? forwarded.split(',')[0] : '') || socketIp;
};
