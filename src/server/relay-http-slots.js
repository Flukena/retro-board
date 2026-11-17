const HTTP_UNAVAILABLE = 503;
const HTTP_TOO_MANY_REQUESTS = 429;
const ADMITTED = 0;

/**
 * Bounds in-flight HTTP requests relay-wide and per client IP. `reserve(ip)` returns `{ status }`: 0 with a
 * `release()` (safe to call twice) when admitted, otherwise 503 (relay full) or 429 (this IP full).
 */
export function createHttpRequestSlots({ maxRequests, maxRequestsPerIp }) {
  let count = 0;
  const byIp = new Map();
  return (ip) => {
    if (count >= maxRequests) return { status: HTTP_UNAVAILABLE };
    if ((byIp.get(ip) || 0) >= maxRequestsPerIp) return { status: HTTP_TOO_MANY_REQUESTS };
    count += 1;
    byIp.set(ip, (byIp.get(ip) || 0) + 1);
    let released = false;
    return {
      status: ADMITTED,
      release() {
        if (released) return;
        released = true;
        count = Math.max(0, count - 1);
        const next = (byIp.get(ip) || 1) - 1;
        if (next > 0) byIp.set(ip, next);
        else byIp.delete(ip);
      },
    };
  };
}
