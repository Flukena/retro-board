const EXACT_URL_ERROR = 'YJS_ALLOWED_ORIGINS must contain exact URL origins';
const EXACT_HTTPS_ERROR = 'YJS_ALLOWED_ORIGINS must contain exact HTTPS origins (or localhost HTTP in dev mode)';

export function readAllowedOrigins(value, allowInsecureHttp = false) {
  const allowedOrigins = (value || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let parsed;
    try { parsed = new URL(origin); }
    catch { throw new Error(EXACT_URL_ERROR); }
    const localHttp = parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.origin !== origin
        || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash
        || (parsed.protocol !== 'https:' && !(allowInsecureHttp && localHttp))) {
      throw new Error(EXACT_HTTPS_ERROR);
    }
  }

  return allowedOrigins;
}
